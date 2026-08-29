#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const cors = require("cors");

const { createCoordinator, listen, writeState } = require("./coordinator/server");
const { SseHub } = require("./lib/sseHub");
const {
  loadRegistry,
  saveRegistry,
  loadSession,
  saveSession,
  loadMemory,
  saveMemory,
  id,
  projectDir,
} = require("./lib/store");
const { seedIfEmpty, emptyMemory, initials } = require("./lib/seed");
const { buildDashboard } = require("./lib/dashboard");
const { homeRelayDir } = require("./lib/paths");
const { appendStopTurn } = require("./lib/memorySync");
const { detectConflicts } = require("./lib/conflicts");
const { createProject, loadProjects, resolveAuth } = require("./lib/centralAuth");
const { appendEvent, listEvents, jsonContext } = require("./lib/centralStore");
const { pushLocalEdits, pullCentralChanges } = require("./lib/centralSync");
const { graphFor, rebuild } = require("./lib/depGraph");
const { initTreeSitter } = require("./lib/treeSitterImports");
const { WorkspaceWatcher } = require("./lib/watchWorkspace");
const os = require("os");
const { computePatch, recordPatch, applyIncoming, applyPeerFile, rewindTo } = require("./lib/patches");
const { harvest } = require("./lib/harvest");
const { syncTranscriptsQueued, latestTranscriptMtime } = require("./lib/transcripts/sync");
const { transcriptWatchRoots, discoverAll } = require("./lib/transcripts/discover");
const { normalizeWorkspaceRoot, normalizeCompare } = require("./lib/transcripts/util");
const { ingest: ingestSupergraph } = require("./lib/supergraph");
const { cloneRepo, addLocal, detectRemoteUrl } = require("./lib/cloneRepo");
const { installProjectHooks, installGlobalHooks } = require("./lib/installHooks");
const { loadRoom, saveRoom, clearRoom, share: shareRoom, ensureTunnel, upsertMember, markLeft, dropMember, membersView } = require("./lib/room");
const { localSnapshot, savePeerSnapshot, mergeRoomViews, clearPeers } = require("./lib/roomSync");
const { compileRoomAsk } = require("./lib/roomAsk");
const { recordCollision, mergeCollisionStats, loadLocalCollisions } = require("./lib/collisionMetrics");
const {
  createInvite,
  revokeInvite,
  inviteView,
  redeemInvite,
  markAccepted,
  issueMemberToken,
  authorizeMember,
  revokeMember,
  publicRoom,
  roomToken,
  isRemoteRequest,
  normLogin,
} = require("./lib/roomAuth");
const {
  repoKeyFromRemote,
  publishSignal,
  findSignal,
  discoverRooms,
  createProof,
  deleteGist,
  verifyProof,
  GIST_SCOPE_HINT,
} = require("./lib/roomSignal");
const { RoomLockMirror } = require("./lib/roomLocks");
const { RoomControl, sendSocket, broadcast } = require("./lib/roomControl");
const { handleRpc: mcpRpc } = require("./mcp/tools");
const { treeFiles, writeTree } = require("./lib/repoSnapshot");
const { whoami } = require("./lib/githubLogin");
const { fetchCollaborators: fetchGithubCollaborators, peekCollaborators } = require("./lib/githubRepo");
const { skipPublish, applyClash, aliveLock } = require("./lib/peerClash");
const { dirtyFiles } = require("./lib/dirtyFiles");
const { authorizeUrl, exchangeCode } = require("./lib/githubOAuth");
const {
  listNotices,
  unreadCount,
  pushNotice,
  markRead,
  markAllRead,
  dismissNotice,
  dismissByKey,
} = require("./lib/notices");
const { WebSocketServer, WebSocket } = require("ws");

const VERSION = "0.1.0";
const UI_ORIGIN = process.env.RELAY_UI_ORIGIN || "http://localhost:3002";

function parsePort(argv) {
  const idx = argv.indexOf("--port");
  if (idx >= 0) return Number(argv[idx + 1]);
  return Number(process.env.RELAY_PORT || 3001);
}

function requireCentral(req, res, next) {
  const auth = resolveAuth(req.headers.authorization);
  if (!auth.ok) return res.status(401).json({ error: "unauthorized" });
  req.central = auth;
  next();
}

async function main() {
  await initTreeSitter();
  seedIfEmpty();
  const app = express();
  app.use(
    cors({
      origin: [UI_ORIGIN, "http://127.0.0.1:3002", "http://localhost:3000", "http://127.0.0.1:3000", /\.ngrok(-free)?\.app$/, /\.ngrok\.io$/],
      credentials: true,
    })
  );
  // A peer's chat history is far larger than any other request body. Mounting
  // its parser first means the 2mb default below sees an already-parsed body and
  // skips it, so one big route does not raise the ceiling for every other.
  app.use("/api/room/history", express.json({ limit: "32mb" }));
  app.use(express.json({ limit: "2mb" }));

  // Visibility into hook traffic: without this, a hook that fails silently
  // (fail-open by design) leaves zero trace that it ever fired, which makes
  // "did the coordinator even see this?" impossible to answer from the
  // terminal running `relay serve`.
  const HOOK_ROUTES = new Set([
    "/api/ensure-workspace",
    "/api/ingest-stop",
    "/api/flush-file",
    "/api/flush-owned",
    "/api/coord/claim",
    "/api/coord/release",
    "/api/coord/release-all",
    "/api/coord/heartbeat",
  ]);
  app.use((req, res, next) => {
    if (!HOOK_ROUTES.has(req.path)) return next();
    const body = req.body || {};
    const ws = body.workspacePath || body.workspaceId || "";
    const detail = [
      body.agentId ? `agent=${body.agentId}` : "",
      body.file ? `file=${body.file}` : "",
      Array.isArray(body.files) && body.files.length ? `files=${body.files.join(",")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const started = Date.now();
    res.on("finish", () => {
      console.log(
        `[relay-hook] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - started}ms) ` +
          `workspace=${ws}${detail ? ` ${detail}` : ""}`
      );
    });
    next();
  });

  const sse = new SseHub();
  try {
    installGlobalHooks();
  } catch {
    /* global configs are best-effort */
  }

  const { app: coordApp, server: coordServer, lockTable, presence } = createCoordinator({
    workspacePath: process.cwd(),
    preferredPort: process.env.RELAY_COORDINATOR_PORT || 0,
  });
  const coordPort = await listen(coordServer, Number(process.env.RELAY_COORDINATOR_PORT || 0));
  coordApp.set("port", coordPort);
  // NOTE: coordinator state is published only once the API port is bound (see
  // server.listen below). Writing it here means a second `relay serve` that
  // dies on EADDRINUSE still overwrites the live instance's pointer with a port
  // that is about to disappear, and every hook then silently degrades to
  // filesystem-only locking.
  function lockScope(projectId) {
    const project =
      loadRegistry().projects.find(
        (p) => p.id === projectId || normalizeCompare(p.path) === normalizeCompare(projectId)
      ) || (projectId ? null : currentProject());
    if (!project) return null;
    const room = loadRoom(project.path) || loadRoom();
    const aliases = [];
    if (
      room &&
      (room.hostProjectId === project.id ||
        room.projectId === project.id ||
        normalizeCompare(room.projectPath) === normalizeCompare(project.path) ||
        normalizeCompare(room.hostWorkspacePath) === normalizeCompare(project.path))
    ) {
      aliases.push(room.hostWorkspacePath, room.projectPath, room.hostProjectId, room.projectId);
    }
    return { id: project.id, path: project.path, aliases: aliases.filter(Boolean) };
  }

  lockTable.on("change", (evt) => {
    const ws = evt?.entry?.workspaceId || evt?.workspaceId;
    const room = loadRoom();
    const project = ws
      ? loadRegistry().projects.find((p) => normalizeCompare(p.path) === normalizeCompare(ws)) ||
        loadRegistry().projects.find((p) => p.id === room?.hostProjectId)
      : null;
    // A guest's locks are namespaced under the HOST's workspace path, so no
    // local project matches and this fell through to `locks: []` — with no
    // workspaceId to scope it, Mission Control applied that blank to whatever
    // it was showing and the Coordinator board emptied itself. Resolve the room
    // workspace instead, and publish the same merged view every other reader
    // gets rather than the raw local table.
    const scope = project
      ? lockScope(project.id)
      : room?.role === "guest" && room.projectId
        ? lockScope(room.projectId) || { id: room.projectId, path: room.projectPath, aliases: [room.hostWorkspacePath] }
        : null;
    if (!scope?.id) return;
    const locks = locksFor(scope);
    const reads = readsFor(scope);
    sse.emit("locks", { workspaceId: scope.id, locks, reads });
    // Control plane only — never share a TCP stream with chat snapshots.
    broadcastLocks(locks, reads);
  });

  const watcher = new WorkspaceWatcher();
  const applyingRemote = new Set();
  let wss = null;
  let wssControl = null;
  const roomControl = new RoomControl();

  function publishGraph(project) {
    if (!project?.path) return;
    const g = rebuild(project.path);
    const snap = g ? g.snapshot() : { edges: [] };
    ingestSupergraph(project.id, { userId: loadSession().login, edges: snap.edges || [] });
    sse.emit("graph", { workspaceId: project.id, graph: snap });
  }

  // Returns null rather than falling back to the currently selected project: a
  // hook that could not report its workspace must not have its edits filed
  // under whichever workspace happens to be open in Mission Control.
  function ensureWorkspace(workspacePath) {
    const resolved = normalizeWorkspaceRoot(workspacePath) || workspacePath;
    if (!resolved) return null;
    const reg = loadRegistry();
    let project = reg.projects.find((p) => normalizeCompare(p.path) === normalizeCompare(resolved));
    if (!project) {
      project = reg.projects.find(
        (p) => normalizeCompare(normalizeWorkspaceRoot(p.path) || p.path) === normalizeCompare(resolved)
      );
      if (project && project.path !== resolved) {
        project.path = resolved;
        saveRegistry(reg);
      }
    }
    if (!project) {
      project = {
        id: id("proj"),
        name: path.basename(resolved),
        initials: initials(resolved),
        color: "#34d399",
        path: resolved,
        remoteUrl: null,
        apiKey: "rl_" + require("crypto").randomBytes(12).toString("hex"),
        createdAt: Date.now(),
        lastSyncAt: Date.now(),
      };
      try {
        fs.mkdirSync(path.join(resolved, ".relay"), { recursive: true });
        installProjectHooks(resolved);
      } catch {
        /* ignore */
      }
      reg.projects.push(project);
      saveRegistry(reg);
      saveMemory(project.id, emptyMemory());
      sse.emit("projects", { projects: reg.projects });
    }
    watcher.watch(project.path, project.id);
    lockTable.track(project.path);
    watchTranscripts(project);
    return project;
  }

  let hostSocket = null;
  // A guest that stops retrying stops receiving the host's edits, silently — and
  // one dropped tunnel request is all it takes. Back off instead of giving up,
  // and cap so a host that is genuinely gone is not hammered.
  let hostBackoffMs = 200;
  let hostRetryTimer = null;
  const HOST_BACKOFF_MAX_MS = 8_000;
  // Filled in once the room helpers below exist. Until then a retry just
  // reconnects to the URL already on disk.
  let refreshGuestRoom = async (room) => room;

  function connectHostPatches(room) {
    if (!room?.url || room.role !== "guest") return;
    if (hostRetryTimer) {
      clearTimeout(hostRetryTimer);
      hostRetryTimer = null;
    }
    if (hostSocket) {
      try {
        hostSocket.close();
      } catch {
        /* ignore */
      }
    }
    const wsUrl = `${room.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws/patches${
      room.memberToken ? `?token=${encodeURIComponent(room.memberToken)}` : ""
    }`;
    try {
      hostSocket = new WebSocket(wsUrl, {
        headers: {
          "ngrok-skip-browser-warning": "relay",
          ...(room.memberToken ? { "x-relay-room-token": room.memberToken } : {}),
        },
      });
    } catch (err) {
      console.warn(`[relay-room] could not open ${wsUrl}: ${err.message || err}`);
      scheduleRetry();
      return;
    }
    let retried = false;
    function scheduleRetry() {
      if (retried) return;
      retried = true;
      const wait = hostBackoffMs;
      hostBackoffMs = Math.min(HOST_BACKOFF_MAX_MS, Math.round(hostBackoffMs * 1.8));
      hostRetryTimer = setTimeout(() => {
        hostRetryTimer = null;
        const retry = async () => {
          let latest = loadRoom();
          if (latest?.role !== "guest") return;
          latest = (await refreshGuestRoom(latest)) || latest;
          connectHostPatches(latest);
          connectHostControl(latest);
        };
        retry().catch(() => undefined);
      }, wait);
      if (hostRetryTimer.unref) hostRetryTimer.unref();
    }
    hostSocket.on("open", () => {
      hostBackoffMs = 200;
      try {
        hostSocket.send(JSON.stringify({ type: "join" }));
      } catch {
        /* first snapshot arrives on connect from the host anyway */
      }
      console.log(`[relay-room] streaming room from ${room.url}`);
    });
    // Without an 'error' listener, ws's EventEmitter rethrows connection
    // failures (e.g. a stale/offline host returning a non-101 response)
    // as an uncaught exception and kills the whole `relay serve` process.
    hostSocket.on("error", (err) => {
      console.warn(`[relay-room] host connection failed (${wsUrl}): ${err.message || err}`);
      scheduleRetry();
    });
    hostSocket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "pong" || msg.type === "ping") {
          if (msg.type === "ping") {
            try {
              hostSocket.send(JSON.stringify({ type: "pong" }));
            } catch {
              /* closed */
            }
          }
          return;
        }
        if (msg.type === "tunnel" && msg.url) {
          const current = loadRoom();
          if (current?.role === "guest" && msg.url !== current.url) {
            saveRoom({ ...current, url: msg.url }, current.projectPath);
            connectHostPatches(loadRoom());
            connectHostControl(loadRoom());
          }
          return;
        }
        if (msg.type === "locks") {
          const current = loadRoom();
          if (msg.workspaceId && current?.hostProjectId && msg.workspaceId !== current.hostProjectId) return;
          roomLocks.accept(msg.locks);
          return;
        }
        if (msg.type === "state" || msg.type === "hello") {
          const project = currentProject();
          const current = loadRoom();
          if (project && current?.hostProjectId) {
            savePeerSnapshot(project.id, "host", msg, msg.hostLogin || current.hostLogin || "host");
            sse.emit("history", {
              workspaceId: project.id,
              lastSyncAt: Date.now(),
              chats: msg.chats,
              timeline: msg.timeline,
              activity: msg.activity,
              edits: msg.edits,
              agents: msg.agents,
              from: msg.hostLogin,
            });
          }
          return;
        }
        if (msg.type !== "patch" || !msg.patch) return;
        const result = acceptPeerPatch(msg.patch, {
          remoteUrl: msg.remoteUrl,
          name: msg.name,
          pathName: msg.pathName,
        }, { skipIfOrigin: true });
        // The guest wrote the file but told nobody: without this the teammate's
        // edit only surfaced on the next full refetch, which is exactly the
        // "live edits never show up" report.
        if (result?.recorded && result.projectId) {
          sse.emit("patch", {
            workspaceId: result.projectId,
            patch: msg.patch,
            incoming: true,
            edit: editRowFor(msg.patch, false),
            originId: msg.patch.originId,
          });
        }
      } catch {
        /* ignore */
      }
    });
    hostSocket.on("close", scheduleRetry);
  }

  let controlSocket = null;
  let controlRetryTimer = null;
  let controlBackoffMs = 200;

  function connectHostControl(room) {
    if (!room?.url || room.role !== "guest") return;
    if (controlRetryTimer) {
      clearTimeout(controlRetryTimer);
      controlRetryTimer = null;
    }
    if (controlSocket) {
      try {
        controlSocket.close();
      } catch {
        /* ignore */
      }
    }
    const wsUrl = `${room.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws/control${
      room.memberToken ? `?token=${encodeURIComponent(room.memberToken)}` : ""
    }`;
    try {
      controlSocket = new WebSocket(wsUrl, {
        headers: {
          "ngrok-skip-browser-warning": "relay",
          ...(room.memberToken ? { "x-relay-room-token": room.memberToken } : {}),
        },
      });
    } catch (err) {
      console.warn(`[relay-room] control socket failed: ${err.message || err}`);
      scheduleControlRetry();
      return;
    }
    roomControl.attach(controlSocket);
    let retried = false;
    function scheduleControlRetry() {
      if (retried) return;
      retried = true;
      const wait = controlBackoffMs;
      controlBackoffMs = Math.min(HOST_BACKOFF_MAX_MS, Math.round(controlBackoffMs * 1.8));
      controlRetryTimer = setTimeout(() => {
        controlRetryTimer = null;
        const latest = loadRoom();
        if (latest?.role === "guest") {
          refreshGuestRoom(latest)
            .then((next) => connectHostControl(next || latest))
            .catch(() => connectHostControl(latest));
        }
      }, wait);
      if (controlRetryTimer.unref) controlRetryTimer.unref();
    }
    controlSocket.on("open", () => {
      controlBackoffMs = 200;
      roomControl.send({ type: "join" });
      console.log(`[relay-room] control stream ${room.url}`);
      // Join first, then settle up: the host has to know who we are before it
      // will accept a release from us.
      if (roomControl.queued) {
        const pending = roomControl.queued;
        roomControl
          .flush()
          .then(({ replayed, rejected, requeued }) => {
            console.log(
              `[relay-room] replayed ${replayed.length}/${pending} queued lock ${
                pending === 1 ? "mutation" : "mutations"
              }${rejected.length ? `, ${rejected.length} rejected` : ""}${
                requeued.length ? `, ${requeued.length} held for the next reconnect` : ""
              }`
            );
          })
          .catch((err) => console.warn(`[relay-room] replay failed: ${err.message || err}`));
      }
    });
    controlSocket.on("error", (err) => {
      console.warn(`[relay-room] control failed: ${err.message || err}`);
      scheduleControlRetry();
    });
    controlSocket.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "ping") {
          roomControl.send({ type: "pong" });
          return;
        }
        if (roomControl.handle(msg)) return;
      } catch {
        /* ignore */
      }
    });
    controlSocket.on("close", scheduleControlRetry);
  }

  /**
   * Push the room's lock table to every joined guest.
   *
   * Only a host has anything to say here: it owns the one table the whole room
   * arbitrates against. Guests receive this and hand it to their mirror, so the
   * board they draw is the host's table itself rather than a periodic guess at
   * it.
   */
  function broadcastLocks(locks, reads) {
    const room = loadRoom();
    if (room?.role !== "host" || !room.url) return;
    const project = currentProject();
    const scope = lockScope(room.hostProjectId || project?.id);
    broadcast(wssControl, {
      type: "locks",
      workspaceId: room.hostProjectId || project?.id || null,
      locks,
      reads: Array.isArray(reads) ? reads : readsFor(scope),
    });
  }

  function broadcastRoom(obj) {
    broadcast(wss, obj);
  }

  function hostWireOpen() {
    return Boolean(hostSocket && hostSocket.readyState === WebSocket.OPEN);
  }

  function sendToHost(obj) {
    if (!hostWireOpen()) return false;
    try {
      hostSocket.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  function roomStatePayload(project, type = "state") {
    const memory = loadMemory(project.id);
    const view = mergeRoomViews(memory);
    const login = currentUser().login || "local";
    return {
      type,
      hostLogin: login,
      projectId: project.id,
      lastTranscriptSyncAt: memory.lastTranscriptSyncAt || 0,
      chats: view.chats,
      timeline: view.timeline,
      activity: view.activity,
      edits: view.edits,
      agents: view.agents,
      stats: memory.stats || {},
      roomCollisions: mergeCollisionStats(memory, { localLogin: login, projectId: project.id }),
    };
  }

  let stateTick = null;
  let lastChatBulkAt = 0;
  function queueRoomState(project) {
    if (!project) return;
    clearTimeout(stateTick);
    stateTick = setTimeout(() => {
      setImmediate(() => {
        const room = loadRoom();
        if (room?.role !== "host" || !room.url) return;
        const payload = roomStatePayload(project);
        const includeChats = Date.now() - lastChatBulkAt > 900;
        if (includeChats) lastChatBulkAt = Date.now();
        else delete payload.chats;
        broadcastRoom(payload);
        setImmediate(() => sse.emit("history", { workspaceId: project.id, lastSyncAt: Date.now(), ...payload }));
      });
    }, 40);
    if (stateTick.unref) stateTick.unref();
  }

  function ingestPeerHistory(login, snapshot, project) {
    if (!login || !project) return;
    savePeerSnapshot(project.id, login, snapshot, login);
    queueRoomState(project);
  }

  /**
   * The activity row a patch produces, shaped exactly like the ones
   * `recordPatch`/`applyPeerFile` write into memory.edits.
   *
   * The dashboard renders `edits`, not `patches`, so a stream that carried only
   * the patch left the feed frozen until the next full refetch — an agent's work
   * was landing on disk while the UI insisted nothing had happened.
   */
  function editRowFor(patch, mine) {
    return {
      id: patch.id,
      agent: patch.agent,
      ownerLogin: patch.ownerLogin,
      mine,
      file: patch.file,
      ts: patch.ts,
      diff: patch.diff || `sha256:${patch.sha256}`,
      lamport: patch.lamport,
      binary: patch.binary,
    };
  }

  /**
   * The dashboard's patch list, without the payload nobody renders.
   *
   * A stored patch carries `content` — the whole file body — so it can be
   * replayed onto disk. Mission Control only ever reads the row fields (it types
   * `patches` as CodeEdit), but the route shipped the raw records: 2.2 MB of the
   * 2.9 MB response, taking seconds to serialise and send. Every streamed
   * `history` event asks the UI to refetch that, so the transport was live while
   * the thing it triggered was not — which is what made streaming look broken.
   */
  const MAX_DIFF_BYTES = 8000;

  function patchRows(patches) {
    const rows = [];
    for (const p of patches.slice(-PATCH_ROWS)) {
      const diff = typeof p.diff === "string" ? p.diff : "";
      rows.push({
        id: p.id,
        agent: p.agent,
        ownerLogin: p.ownerLogin,
        mine: p.mine,
        file: p.file,
        ts: p.ts,
        lamport: p.lamport,
        binary: p.binary,
        diff: diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… truncated` : diff,
      });
    }
    return rows;
  }

  const PATCH_ROWS = 100;

  function broadcastPatch(payload) {
    const edit = payload.patch ? editRowFor(payload.patch, !payload.incoming) : null;
    sse.emit("patch", edit ? { ...payload, edit } : payload);
    broadcastRoom({ type: "patch", ...payload });
    if (payload.patch) notifyWaiters(payload);
  }

  /**
   * Hand the finished file to whoever was told to wait for it.
   *
   * An agent refused a claim was left to poll or simply give up, so it carried
   * on against a stale copy of a file that had since changed underneath it —
   * the exact divergence locking exists to prevent. The moment the edit lands,
   * everyone who wanted that file learns it is free and what changed.
   */
  function notifyWaiters({ workspaceId, patch }) {
    const project = loadRegistry().projects.find((p) => p.id === workspaceId);
    if (!project || !patch?.file) return;
    const waiters = lockTable.takeWaiters(patch.file, project.path);
    if (!waiters.length) return;
    const item = {
      workspaceId: project.id,
      file: patch.file,
      lamport: patch.lamport,
      sha256: patch.sha256,
      by: patch.agent,
      waiters: waiters.map((w) => w.agentId),
      ts: Date.now(),
    };
    sse.emit("file-ready", item);
    broadcastRoom({ type: "file-ready", ...item });
    emitNotice(
      {
        type: "file-ready",
        key: `file-ready:${project.id}:${patch.file}`,
        title: `${patch.file} is free`,
        body: `${patch.agent} finished editing it — ${waiters.length} agent(s) were waiting.`,
        workspaceId: project.id,
        payload: { file: patch.file, lamport: patch.lamport },
      },
      { revive: true }
    );
  }

  function fanOutLocalFile(project, file, originAgentId) {
    if (!project?.path || !file) return { flushed: false };
    const rel = file.replace(/\\/g, "/");
    const session = loadSession();
    const patch = computePatch({
      workspacePath: project.path,
      file: rel,
      agent: "fs.watch",
      ownerLogin: session.login || "local",
      workspaceId: project.id,
    });
    if (!patch) return { flushed: false };
    // Second half of the echo guard in applyPatchToDisk: a watcher event whose
    // content matches the newest patch we already know for this file is our own
    // write coming back, not a new edit worth sending to the room.
    const known = (loadMemory(project.id).patches || []).filter((p) => p.file === rel).pop();
    if (known && known.sha256 === patch.sha256) return { flushed: false, unchanged: true, file: rel };
    patch.originId = originId();
    patch.originAgentId = originAgentId || originId();
    recordPatch(project.id, patch);
    const envelope = {
      workspaceId: project.id,
      patch,
      remoteUrl: project.remoteUrl,
      name: project.name,
      pathName: path.basename(project.path),
      originId: patch.originId,
    };
    broadcastPatch(envelope);
    const room = loadRoom(project.path);
    if (room?.url && room.role !== "host") {
      const body = { ...envelope, workspaceId: room.hostProjectId || envelope.workspaceId, type: "patch" };
      if (!sendToHost(body)) {
        fetch(`${room.url.replace(/\/$/, "")}/api/patches`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "ngrok-skip-browser-warning": "relay",
            ...(room.memberToken ? { "x-relay-room-token": room.memberToken } : {}),
          },
          body: JSON.stringify(body),
        })
          .then((r) => {
            if (!r.ok) console.warn(`[relay-room] host rejected patch for ${rel}: ${r.status}`);
          })
          .catch((err) => console.warn(`[relay-room] could not send patch for ${rel}: ${err.message || err}`));
      }
    }
    const memory = loadMemory(project.id);
    pushLocalEdits(project.path, project.id, memory).then(() => pullCentralChanges(project.path)).catch(() => undefined);
    publishGraph(project);
    return { flushed: true, file: rel };
  }

  function projectForPath(workspacePath) {
    if (!workspacePath) return null;
    return (
      loadRegistry().projects.find((p) => normalizeCompare(p.path) === normalizeCompare(workspacePath)) ||
      ensureWorkspace(workspacePath)
    );
  }

  // Watcher events parked behind a live local lock, replayed once the holder
  // lets go. fanOutLocalFile is idempotent (it drops a patch whose sha matches
  // the newest one recorded for the file), so a post-tool flush that did arrive
  // simply makes the replay a no-op.
  const deferredEdits = new Map();
  const DEFERRED_MAX_MS = 5 * 60 * 1000;

  /**
   * Trailing-edge, not leading-edge.
   *
   * This used to publish the first event for a file and drop every further one
   * inside a 40ms window. An agent that writes a file in more than one chunk —
   * which the fast Gemini-class models do constantly — therefore published a
   * snapshot taken mid-write and then threw away the event carrying the
   * finished content. There is no later event to correct it, so the edit either
   * never appeared or appeared truncated. Waiting for the file to stop changing
   * costs one debounce interval and always publishes the final state.
   */
  const WATCH_SETTLE_MS = 60;
  const watchTimers = new Map();

  watcher.on("change", (evt) => {
    const key = `${evt.workspacePath}:${evt.file}`;
    clearTimeout(watchTimers.get(key));
    watchTimers.set(
      key,
      setTimeout(() => {
        watchTimers.delete(key);
        onFileSettled(evt);
      }, WATCH_SETTLE_MS)
    );
  });

  function onFileSettled({ workspacePath, workspaceId, file }) {
    const now = Date.now();
    if (workspaceId && applyingRemote.has(workspaceId)) return;
    const project =
      loadRegistry().projects.find((p) => p.id === workspaceId || p.path === workspacePath) ||
      ensureWorkspace(workspacePath);
    if (!project) return;
    if (applyingRemote.has(project.id) || applyingRemote.has(`${project.id}:${file}`)) return;
    const rel = file.replace(/\\/g, "/");
    const publish = skipPublish(lockTable, project.path, rel);
    if (publish.skip) {
      bumpCollision(project.id, "patch_skipped", {
        file: rel,
        holder: publish.held?.agentId,
        reason: publish.reason,
      });
      return;
    }
    const held = publish.held;
    if (held) lockTable.heartbeat({ agentId: held.agentId, file: rel, workspaceId: project.path });
    if (publish.defer) {
      // Deferring is correct — a file being written under a live local lock is
      // still mid-edit, and the agent's post-tool hook publishes the finished
      // result. But that made publication conditional on a hook we do not
      // control: if PostToolUse never fires (or fires with a payload shape we
      // cannot read a path out of), the watcher event is consumed here, the
      // lock quietly expires, and the edit is never published at all. Remember
      // it instead and let the lock's own release or expiry release the edit.
      deferredEdits.set(`${project.id}:${rel}`, { project, rel, agentId: held?.agentId || null, at: now });
      bumpCollision(project.id, "patch_deferred", { file: rel, agentId: held?.agentId });
      return;
    }
    fanOutLocalFile(project, rel, held?.agentId);
  }

  const deferredSweep = setInterval(() => {
    if (!deferredEdits.size) return;
    const now = Date.now();
    for (const [key, entry] of [...deferredEdits]) {
      const stale = now - entry.at > DEFERRED_MAX_MS;
      if (!stale && aliveLock(lockTable, entry.rel, entry.project.path)) continue;
      deferredEdits.delete(key);
      if (stale) continue;
      try {
        fanOutLocalFile(entry.project, entry.rel, entry.agentId);
      } catch (err) {
        console.warn(`[relay] deferred publish ${entry.rel}: ${err.message || err}`);
      }
    }
  }, 750);
  if (deferredSweep.unref) deferredSweep.unref();

  const transcriptWatchers = new Map();

  // A transcript sync is fully synchronous and parses every transcript the
  // workspace owns — tens of megabytes for a long-lived project. Agents rewrite
  // their transcript continuously while a turn is in flight, so without a floor
  // between passes the server spends every tick re-parsing the same files and
  // never gets back to serving HTTP or flushing sockets.
  const INGEST_COOLDOWN_MS = 2500;
  const lastIngest = new Map();
  const ingestAgain = new Set();

  // Activity is a transcript log, so it appears as soon as the jsonl is parsed.
  // Coordinator only painted live claims, and PostToolUse releases those in
  // ~100ms — the board looked empty while the feed was already full. Mirror
  // recent transcript edits onto the same afterglow the lock table keeps for
  // released claims, so both tabs share one trail. This is display-only:
  // claim() never sees remembered rows.
  function observeTranscriptEdits(project, memory) {
    const cutoff = Date.now() - 45_000;
    let touched = 0;
    for (const edit of memory?.edits || []) {
      if (!edit?.file || (edit.ts || 0) < cutoff) continue;
      lockTable.remember({
        filePath: String(edit.file).replace(/\\/g, "/"),
        agentId: `${edit.agent}:${os.hostname()}:transcript`,
        mode: "write",
        claimedAt: edit.ts,
        lastHeartbeat: edit.ts,
        ttlMs: 15_000,
        workspaceId: project.path,
        holder: { label: edit.agent, login: edit.ownerLogin || null },
        source: "transcript",
        releasedAt: edit.ts,
      });
      touched += 1;
    }
    if (touched) lockTable.emit("change");
  }

  function ingestTranscripts(project) {
    const since = Date.now() - (lastIngest.get(project.id) || 0);
    if (since < INGEST_COOLDOWN_MS) {
      // Coalesce rather than drop: the newest write still gets ingested, just on
      // the trailing edge instead of once per filesystem event.
      if (!ingestAgain.has(project.id)) {
        ingestAgain.add(project.id);
        setTimeout(() => {
          ingestAgain.delete(project.id);
          ingestTranscripts(project);
        }, INGEST_COOLDOWN_MS - since).unref?.();
      }
      return Promise.resolve();
    }
    lastIngest.set(project.id, Date.now());
    return syncTranscriptsQueued(project, { ownerLogin: loadSession().login || "local" })
      .then((memory) => {
        observeTranscriptEdits(project, memory);
        // Carry the refreshed views on the event itself. A bare notification
        // makes the client turn around and refetch the whole dashboard, so the
        // "stream" was really just a trigger for a multi-megabyte poll.
        sse.emit("history", {
          workspaceId: project.id,
          lastSyncAt: Date.now(),
          chats: memory?.chats,
          timeline: memory?.timeline,
          activity: memory?.activity,
          edits: memory?.edits,
          agents: memory?.agents,
        });
        // Push as soon as the transcript settles rather than waiting for the
        // next dashboard poll, so a teammate sees the turn land in seconds.
        const room = loadRoom(project.path);
        if (room?.role === "host") queueRoomState(project);
        return pushRoomHistory(room, project);
      })
      .catch(() => undefined);
  }

  /**
   * A brand-new workspace has no transcript directory yet: Cursor and
   * Antigravity only create theirs on the first turn. fs.watch cannot watch a
   * path that does not exist, so a one-shot arm at boot leaves that workspace
   * permanently silent — the "my edits never show up on the new repo" symptom.
   * Re-arming lets a root that appears later still get picked up.
   */
  function watchTranscripts(project) {
    if (!project?.path) return;
    const state = transcriptWatchers.get(project.id) || { roots: new Set(), timer: null };
    transcriptWatchers.set(project.id, state);
    for (const root of transcriptWatchRoots(project.path)) {
      state.roots.add(root);
      armTranscriptRoot(root);
    }
  }

  /**
   * One recursive watch per directory, shared by every workspace interested in
   * it.
   *
   * Most transcript roots are not workspace-specific: `~/.codex/sessions` and
   * Antigravity's `brain/` hold every conversation on the machine, so all eight
   * registered workspaces resolved to the same two directories and each armed
   * its own watcher — 23 handles over 9 directories. A single Antigravity write
   * then fanned out to eight independent transcript syncs, each re-parsing that
   * workspace's transcripts from scratch. That is the stall: Antigravity writes
   * its transcript continuously while answering, so the server spent all of its
   * time re-parsing and none of it serving the dashboard or the lock stream.
   */
  const transcriptRootHandles = new Map();

  function armTranscriptRoot(root) {
    if (transcriptRootHandles.has(root)) return;
    let handle;
    try {
      handle = fs.watch(root, { recursive: true }, (_evt, filename) => {
        onTranscriptRootChange(root, filename);
      });
    } catch {
      return; // directory not there yet — the sweep retries
    }
    handle.on("error", () => {
      try {
        handle.close();
      } catch {
        /* already gone */
      }
      transcriptRootHandles.delete(root);
    });
    transcriptRootHandles.set(root, handle);
  }

  function onTranscriptRootChange(root, filename) {
    const changed = filename ? path.resolve(root, filename) : null;
    for (const [projectId, state] of transcriptWatchers) {
      if (!state.roots.has(root)) continue;
      const project = loadRegistry().projects.find((p) => p.id === projectId);
      if (!project) continue;
      // A shared root fires for conversations belonging to other workspaces.
      // Ingesting all of them on every event is what multiplied the cost;
      // ownsTranscript keeps a write charged to the workspace it belongs to.
      if (changed && !ownsTranscript(project, changed)) continue;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => ingestTranscripts(project), 150);
    }
  }

  // Cheap membership test against the transcript set discovery already computed,
  // refreshed lazily so a brand-new conversation still gets picked up.
  const OWNERSHIP_TTL_MS = 10000;
  const ownership = new Map();

  function ownsTranscript(project, absFile) {
    const hit = ownership.get(project.id);
    let files = hit && Date.now() - hit.at < OWNERSHIP_TTL_MS ? hit.files : null;
    if (!files) {
      try {
        files = new Set(
          discoverAll(normalizeWorkspaceRoot(project.path) || project.path).map((f) => path.resolve(f.file))
        );
      } catch {
        files = new Set();
      }
      ownership.set(project.id, { files, at: Date.now() });
    }
    // Unknown file: it may be a conversation that started moments ago, so let it
    // through once and let the refreshed set decide next time.
    if (files.has(absFile)) return true;
    if (hit && Date.now() - hit.at < OWNERSHIP_TTL_MS) return false;
    return true;
  }

  for (const p of loadRegistry().projects) {
    if (p.path) {
      watcher.watch(p.path, p.id);
      lockTable.track(p.path);
    }
    watchTranscripts(p);
  }

  // Watchers are the fast path, not the only one. This sweep re-arms roots that
  // have since been created and ingests when a transcript moved but no watch
  // event arrived (network drives, editors that write via rename, a agent whose
  // storage directory did not exist when the workspace was registered).
  // Every pass costs a full transcript discovery per workspace — hundreds of
  // milliseconds of synchronous stat/read work across the registry. At 3s that
  // was a fifth of the event loop spent on a path that only exists to cover
  // events fs.watch missed. The deduped watchers above are the fast path; this
  // only has to be eventually-correct.
  const transcriptSweep = setInterval(() => {
    for (const project of loadRegistry().projects) {
      if (!project.path) continue;
      lockTable.track(project.path);
      watchTranscripts(project);
      try {
        const seen = loadMemory(project.id).lastTranscriptSyncAt || 0;
        const root = normalizeWorkspaceRoot(project.path) || project.path;
        if (latestTranscriptMtime(root) > seen) ingestTranscripts(project);
      } catch {
        /* keep sweeping the other workspaces */
      }
    }
  }, 10000);
  if (transcriptSweep.unref) transcriptSweep.unref();
  try {
    installProjectHooks(process.cwd());
  } catch {
    /* ignore */
  }

  function originId() {
    const session = loadSession();
    return `${os.hostname()}:${session.login || "local"}`;
  }

  function peerProject(hint = {}) {
    const reg = loadRegistry();
    // A joined room pins the workspace incoming patches belong to. Without this
    // the chain below falls through to currentProject(), and a guest whose
    // dashboard happens to be on a different repo has the host's files written
    // into it.
    const room = loadRoom();
    if (room?.projectId) {
      const pinned = reg.projects.find((p) => p.id === room.projectId);
      if (pinned) return pinned;
    }
    const byRemote = hint.remoteUrl && reg.projects.find((p) => p.remoteUrl && p.remoteUrl === hint.remoteUrl);
    if (byRemote) return byRemote;
    const byName = hint.name && reg.projects.find((p) => p.name === hint.name);
    if (byName) return byName;
    if (hint.pathName) {
      const byBase = reg.projects.find((p) => path.basename(p.path) === hint.pathName);
      if (byBase) return byBase;
    }
    return currentProject();
  }

  function acceptPeerPatch(patch, hint, { skipIfOrigin } = {}) {
    if (!patch?.file) return { applied: false };
    if (skipIfOrigin && patch.originId && patch.originId === originId()) {
      return { applied: false, self: true };
    }
    const project = peerProject(hint);
    if (!project) return { applied: false, reason: "no_local_repo" };
    const clash = applyClash(lockTable, project.path, patch.file, patch);
    if (clash) {
      if (project?.id) {
        bumpCollision(project.id, "patch_blocked", {
          file: patch.file,
          holder: clash.holder,
          agent: patch.agent,
          reason: clash.reason,
        });
      }
      return { applied: false, projectId: project.id, ...clash };
    }
    applyingRemote.add(`${project.id}:${patch.file}`);
    const result = applyPeerFile(project.id, patch, project.path);
    applyingRemote.delete(`${project.id}:${patch.file}`);
    return { ...result, projectId: project.id };
  }

  const currentProject = () => {
    const reg = loadRegistry();
    const session = loadSession();
    return reg.projects.find((p) => p.id === session.projectId) || reg.projects[0] || null;
  };

  function currentUser() {
    const { session, user } = whoami();
    if (user) {
      return {
        id: user.id,
        login: user.login,
        name: user.name || user.login,
        avatarUrl: user.avatarUrl || `https://github.com/${user.login}.png`,
      };
    }
    const login = session.login || os.userInfo().username || "local";
    return { id: `local_${login}`, login, name: login, avatarUrl: "" };
  }

  // Every dashboard poll fans out to the room host. Without a deadline, one
  // unreachable tunnel stalls the request the UI refreshes on every 8s, and the
  // whole dashboard reads as "not loading".
  const HOST_TIMEOUT_MS = 2500;
  // A full-tree seed is megabytes over a tunnel; the dashboard deadline is far
  // too short for it.
  const SEED_TIMEOUT_MS = 120_000;

  async function fetchHost(url, pathname, init = {}) {
    // Every room request carries the member token the host minted at redeem
    // time; without it an invite-only host answers 401.
    const token = init.token === null ? null : init.token || loadRoom()?.memberToken;
    const res = await fetch(`${String(url).replace(/\/$/, "")}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(init.timeoutMs || HOST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "relay",
        ...(token ? { "x-relay-room-token": token } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const err = new Error(`${pathname} ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  const sameLogin = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();

  /**
   * Team tab roster: GitHub collaborators are the stable rows. Room presence
   * overlays on top by login. Kick/leave drop the room overlay, never the
   * GitHub identity.
   */
  function overlayTeam(ghList, roomMembers) {
    const roomByLogin = new Map();
    for (const m of roomMembers || []) {
      const key = String(m?.login || "").toLowerCase();
      if (key) roomByLogin.set(key, m);
    }
    const seen = new Set();
    const rows = [];
    for (const gh of ghList || []) {
      const key = String(gh.login || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const live = roomByLogin.get(key);
      const inRoom = Boolean(live);
      rows.push({
        id: gh.id || live?.id || `gh_${gh.login}`,
        login: gh.login,
        name: (inRoom && live.name) || gh.name || gh.login,
        avatarUrl: (inRoom && live.avatarUrl) || gh.avatarUrl || "",
        permission: gh.permission || null,
        source: "github",
        inRoom,
        role: inRoom ? live.role : undefined,
        online: inRoom ? Boolean(live.online) : false,
        agentActive: inRoom ? Boolean(live.agentActive) : false,
        agentLabel: inRoom ? live.agentLabel || null : null,
      });
    }
    for (const live of roomMembers || []) {
      const key = String(live.login || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...live,
        source: "room",
        inRoom: true,
        online: Boolean(live.online),
        agentActive: Boolean(live.agentActive),
        agentLabel: live.agentLabel || null,
      });
    }
    return rows;
  }

  /**
   * Is this person a collaborator on the repo being shared?
   *
   * `verified: false` means we could not find out — no GitHub remote, `gh` not
   * installed or not authed. It does NOT mean "not a collaborator", and the
   * caller must not treat it as a rejection: the invite code is itself a
   * host-issued, single-use, expiring credential, so an unverifiable repo
   * degrades to invite-only rather than becoming unjoinable.
   *
   * The public contributors fallback in githubRepo is deliberately not accepted
   * as proof here — it is activity-derived public data, not an access list.
   */
  async function collaboratorCheck(project, login) {
    try {
      const list = await fetchGithubCollaborators(project?.remoteUrl);
      const authoritative = list.filter((c) => c.source === "collaborators");
      if (!authoritative.length) return { verified: false, allowed: true, reason: "unverifiable" };
      const match = authoritative.find((c) => sameLogin(c.login, login));
      return match
        ? { verified: true, allowed: true, permission: match.permission || null }
        : { verified: true, allowed: false, reason: "not_a_collaborator" };
    } catch {
      return { verified: false, allowed: true, reason: "lookup_failed" };
    }
  }

  // Guards everything a room exposes through the tunnel. Local Mission Control
  // and local hooks reach the same routes over loopback and are left alone, so
  // solo use is unaffected by any of this.
  function requireRoomMember(req, res, next) {
    const room = loadRoom();
    const hosting = Boolean(room?.url) && room.role === "host";
    // Identify the caller from its credential whenever one is present, even on a
    // loopback request. Downstream scoping depends on knowing "this is a peer",
    // and inferring that from proxy headers alone is a guess; the token is proof.
    if (hosting) {
      const member = authorizeMember(room, roomToken(req));
      if (member) req.roomMember = member;
    }
    if (!isRemoteRequest(req)) return next();
    if (!hosting) return next();
    if (room.open) return next();
    if (!req.roomMember) {
      return res.status(401).json({
        error: "not_a_member",
        hint: "This room is invite-only. Ask the host to send you an invite link.",
      });
    }
    return next();
  }

  function activeAgent(projectId) {
    const memory = loadMemory(projectId);
    const live = (memory.agents || [])
      .filter((a) => a.status === "connected" && Date.now() - (a.lastActiveAt || 0) < 120_000)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0];
    return live ? { agentActive: true, agentLabel: live.label } : { agentActive: false, agentLabel: null };
  }

  async function announceToHost(room, user = currentUser()) {
    if (!room?.url || room.role !== "guest") return null;
    const res = await fetchHost(room.url, "/api/room/hello", {
      method: "POST",
      body: JSON.stringify({
        user: { ...user, ...(room.projectId ? activeAgent(room.projectId) : {}) },
        role: "guest",
        // Without this the host resolved the room from whichever project it
        // happens to have selected, so a guest's hello could land on the wrong
        // workspace's roster — or 409 and leave the guest with no roster at all.
        hostProjectId: room.hostProjectId,
      }),
    });
    return res.json();
  }

  // The roster a guest last heard from the host, cached in its own room.json.
  // The Team tab is rendered from a live round trip, so without a cache a single
  // slow or dropped tunnel request blanks the whole collaborator list.
  function rememberRoster(workspacePath, roster) {
    const room = loadRoom(workspacePath);
    if (!room) return;
    const now = Date.now();
    saveRoom(
      {
        ...room,
        // membersView recomputes online from lastSeen, so stamping only the
        // members the host reported as online lets presence decay naturally if
        // the host becomes unreachable, instead of freezing everyone online.
        members: roster.map((m) => ({ ...m, lastSeen: m.online ? now : m.lastSeen || 0 })),
      },
      workspacePath
    );
  }

  // Locks live on the host while a room is joined. Mirroring them locally keeps
  // /api/locks, the Coordinator tab's SSE stream and the dashboard consistent
  // instead of each reporting a different (and mostly empty) answer.
  const roomLocks = new RoomLockMirror({
    fetchLocks: async (room) => {
      const body = await fetchHost(room.url, `/api/locks?projectId=${encodeURIComponent(room.hostProjectId)}`).then((r) =>
        r.json()
      );
      return { locks: body.locks || [], reads: body.reads || [] };
    },
  });
  /**
   * A replayed release the host would not take. The agent that queued it has
   * long since moved on and is not watching the board, so this has to be a
   * notice rather than a socket event nobody is listening for.
   */
  roomControl.onReplay = ({ rejected }) => {
    // Only a host verdict is worth a notice. A transport failure has been put
    // back on the queue and will go out on the next reconnect, so reporting it
    // would be crying wolf about work that is still in hand.
    if (!rejected?.length) return;
    const room = loadRoom();
    const files = [...new Set(rejected.map((r) => r.body?.file).filter(Boolean))];
    emitNotice(
      {
        type: "replay_rejected",
        key: `replay_rejected:${room?.roomId || "room"}`,
        title: `${rejected.length} offline ${rejected.length === 1 ? "release" : "releases"} did not reach the host`,
        body: files.length
          ? `Still held room-wide until they expire: ${files.slice(0, 3).join(", ")}${
              files.length > 3 ? ` and ${files.length - 3} more` : ""
            }.`
          : "They will expire on their own TTL.",
        workspaceId: room?.projectId || currentProject()?.id || null,
      },
      { revive: true }
    );
  };

  roomControl.onLocks = (msg) => {
    const current = loadRoom();
    if (msg.workspaceId && current?.hostProjectId && msg.workspaceId !== current.hostProjectId) return;
    roomLocks.accept(msg.locks, { reads: msg.reads });
  };
  roomLocks.on("change", ({ locks, reads }) => {
    const room = loadRoom();
    const workspaceId = room?.projectId || currentProject()?.id;
    sse.emit("locks", {
      workspaceId,
      locks,
      reads: Array.isArray(reads) ? reads : readsFor(lockScope(workspaceId)),
    });
    const health = roomLocks.health;
    if (health.joined && !health.reachable && roomLocks.failures >= 3) {
      emitNotice(
        {
          type: "host_offline",
          key: `host_offline:${room?.roomId || "room"}`,
          title: `@${room?.hostLogin || "host"} went offline`,
          body: "Waiting to reconnect to the shared room.",
          workspaceId: room?.projectId || currentProject()?.id || null,
        },
        { revive: true }
      );
    }
    if (health.joined && health.reachable) {
      const key = `host_offline:${room?.roomId || "room"}`;
      if (dismissByKey(key)) {
        emitNotice(
          {
            type: "host_online",
            key: `host_online:${room?.roomId || "room"}`,
            title: `@${room?.hostLogin || "host"} is back`,
            body: "Reconnected to the shared room.",
            workspaceId: room?.projectId || currentProject()?.id || null,
          },
          { revive: true }
        );
      }
    }
  });

  function syncRoomLocks() {
    roomLocks.start(loadRoom());
  }

  function shareExtras(project) {
    const user = currentUser();
    return {
      hostProjectId: project?.id,
      workspacePath: project?.path,
      projectName: project?.name,
      hostUser: user,
      hostLogin: user.login,
      repoKey: repoKeyFromRemote(project?.remoteUrl),
    };
  }

  const discoverState = { at: 0, key: "", rooms: [] };

  async function refreshOpenRooms(project, { force } = {}) {
    const key = repoKeyFromRemote(project?.remoteUrl);
    if (!key) return [];
    if (!force && discoverState.key === key && Date.now() - discoverState.at < 12_000) return discoverState.rooms;
    const me = currentUser().login;
    let collabs = [];
    try {
      collabs = await fetchGithubCollaborators(project.remoteUrl);
    } catch {
      collabs = [];
    }
    const rooms = await discoverRooms({
      repoKey: key,
      logins: collabs.map((c) => c.login),
      myLogin: me,
    });
    discoverState.at = Date.now();
    discoverState.key = key;
    discoverState.rooms = rooms;
    syncInviteNotices(project, rooms);
    return rooms;
  }

  function emitNotice(input, opts) {
    const notice = pushNotice(input, opts);
    if (notice) sse.emit("notice", notice);
    return notice;
  }

  function syncInviteNotices(project, rooms) {
    const current = loadRoom(project?.path);
    const live = new Set();
    for (const room of rooms || []) {
      if (!room?.roomId) continue;
      const key = `invite:${room.roomId}`;
      live.add(key);
      if (current?.roomId && current.roomId === room.roomId) continue;
      emitNotice({
        type: "invite",
        key,
        title: `@${room.hostLogin} invited you`,
        body: `Join the shared room${room.projectName ? ` for ${room.projectName}` : ""}.`,
        action: "join",
        workspaceId: project?.id || null,
        payload: {
          hostLogin: room.hostLogin,
          roomId: room.roomId,
          gistId: room.gistId || null,
          url: room.url,
          projectName: room.projectName || project?.name || null,
          projectId: project?.id || null,
        },
      });
    }
    for (const n of listNotices()) {
      if (n.type === "invite" && n.key && !live.has(n.key) && !(current?.roomId && n.key === `invite:${current.roomId}`)) {
        dismissByKey(n.key);
      }
    }
  }

  let tunnelWatchTimer = null;
  let tunnelMaintainInFlight = null;

  function stopTunnelWatch() {
    if (tunnelWatchTimer) clearInterval(tunnelWatchTimer);
    tunnelWatchTimer = null;
  }

  function startTunnelWatch() {
    if (tunnelWatchTimer) return;
    tunnelWatchTimer = setInterval(() => maintainHostTunnel().catch(() => undefined), 12000);
    if (tunnelWatchTimer.unref) tunnelWatchTimer.unref();
  }

  async function publishAndWatch(room, project) {
    let warning = null;
    try {
      const published = await publishSignal(room, {
        repoKey: repoKeyFromRemote(project?.remoteUrl) || room.repoKey,
        hostLogin: currentUser().login,
      });
      if (published?.ok && published.gistId && published.gistId !== room.signalGistId) {
        room.signalGistId = published.gistId;
        saveRoom(room, project?.path || room.projectPath);
      } else if (!published?.ok) {
        warning = GIST_SCOPE_HINT;
      }
    } catch {
      warning = GIST_SCOPE_HINT;
    }
    startTunnelWatch();
    return warning;
  }

  async function maintainHostTunnel() {
    if (tunnelMaintainInFlight) return tunnelMaintainInFlight;
    tunnelMaintainInFlight = maintainHostTunnelOnce().finally(() => {
      tunnelMaintainInFlight = null;
    });
    return tunnelMaintainInFlight;
  }

  async function maintainHostTunnelOnce() {
    const project = currentProject();
    const room = loadRoom(project?.path);
    if (room?.role !== "host") {
      stopTunnelWatch();
      return;
    }
    const port = parsePort(process.argv);
    let listedUrl = null;
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const tunnels = (await res.json()).tunnels || [];
        listedUrl =
          (tunnels.find((t) => String(t.public_url || "").startsWith("https://")) || tunnels[0] || {}).public_url || null;
      }
    } catch {
      listedUrl = null;
    }
    // Inspector already has a tunnel: reuse it. Do not call ensureTunnel (and
    // never spawnNgrok) just because a public-URL probe would be slow or fail.
    let url = listedUrl;
    if (!listedUrl) {
      const now = Date.now();
      if (now - lastTunnelProbeAt < 8000) return;
      lastTunnelProbeAt = now;
      url = await ensureTunnel(port);
    }
    if (!url) return;
    if (url === room.url && room.live !== false) {
      if (!room.signalGistId) await publishAndWatch(room, project);
      return;
    }
    const previous = room.url;
    room.url = url;
    room.live = true;
    saveRoom(room, project?.path);
    const warning = await publishAndWatch(room, project);
    if (previous !== url) console.log(`[relay-room] tunnel is ${url}`);
    if (warning) console.warn(`[relay-room] ${warning}`);
    if (previous !== url) {
      sse.emit("presence", { workspaceId: project?.id, tunnel: url });
      broadcastRoom({ type: "tunnel", url });
    }
  }

  refreshGuestRoom = async function refreshGuestRoomNow(room) {
    if (room?.role !== "guest") return room;
    const project = currentProject();
    const repoKey = room.repoKey || repoKeyFromRemote(project?.remoteUrl);
    try {
      const signal = await findSignal({
        gistId: room.signalGistId,
        hostLogin: room.hostLogin,
        repoKey,
        roomId: room.roomId,
      });
      if (!signal?.url || signal.live === false) return room;
      if (signal.url === room.url) return room;
      const next = saveRoom(
        {
          ...room,
          url: signal.url,
          roomId: signal.roomId || room.roomId,
          signalGistId: signal.gistId || room.signalGistId,
          repoKey: signal.repoKey || repoKey,
          hostLogin: signal.hostLogin || room.hostLogin,
        },
        room.projectPath || project?.path
      );
      console.log(`[relay-room] host moved to ${signal.url}`);
      sse.emit("presence", { workspaceId: room.projectId || project?.id, reconnect: true });
      emitNotice(
        {
          type: "host_online",
          key: `host_online:${room.roomId || "room"}`,
          title: `@${room.hostLogin || "host"} is back`,
          body: "Reconnected to the shared room.",
          workspaceId: room.projectId || project?.id || null,
        },
        { revive: true }
      );
      dismissByKey(`host_offline:${room.roomId || "room"}`);
      syncRoomLocks();
      return next;
    } catch {
      return room;
    }
  };

  /**
   * What this machine should show as "the locks".
   *
   * A guest's own table is normally empty — its hooks claim against the host —
   * so the mirror leads. But a hook that hit the room while the tunnel was down
   * falls back to the local coordinator (see coordinator/client.js), and those
   * claims exist nowhere else: returning the mirror alone made the guest's own
   * in-progress edits invisible on its own board.
   *
   * Merge instead. A local row is dropped only when the host already has the
   * same file under the same agent — that is the same lock seen twice. A local
   * row held by a DIFFERENT agent is the genuine double-hold a tunnel outage
   * opens up (both sides fail open by design), and dropping it is what made
   * that conflict invisible on the one screen that should be shouting about it.
   */
  function readsFor(scope) {
    try {
      if (!scope) return [];
      const { filterKeys } = require("./coordinator/lockTable");
      const local = lockTable.readsFor(filterKeys(scope));
      const mirrored = typeof roomLocks.listReads === "function" ? roomLocks.listReads() : null;
      if (!mirrored) return local;
      const onHost = new Set(mirrored.map((r) => `${r.filePath}::${r.agentId}`));
      return [...mirrored, ...local.filter((r) => !onHost.has(`${r.filePath}::${r.agentId}`))];
    } catch (err) {
      console.warn(`[relay] readsFor: ${err.message || err}`);
      return [];
    }
  }

  function locksFor(scope) {
    try {
      const mirrored = roomLocks.list();
      const local = scope ? lockTable.list(scope) : [];
      if (!mirrored) return local;
      const onHost = new Set(mirrored.map((l) => `${l.filePath}::${l.agentId}`));
      return [...mirrored, ...local.filter((l) => !onHost.has(`${l.filePath}::${l.agentId}`))];
    } catch (err) {
      console.warn(`[relay] locksFor: ${err.message || err}`);
      return [];
    }
  }

  // Only pushed when local transcripts actually moved. The live WebSocket is the
  // delivery path; HTTP is the fallback when the tunnel is down.
  const lastPushedSync = new Map();

  // Only guests push. The host is already the aggregator — sending its own
  // history out through its tunnel and back would be a pointless round trip.
  async function pushRoomSnapshot(room, project, { force } = {}) {
    if (room?.role !== "guest" || !room.url || !project) return;
    const target = room.hostProjectId;
    if (!target) return;
    const memory = loadMemory(project.id);
    const stamp = memory.lastTranscriptSyncAt || 0;
    const collisionStamp = loadLocalCollisions(project.id).updatedAt || 0;
    const pushKey = `${stamp}:${collisionStamp}`;
    if (!force && lastPushedSync.get(project.id) === pushKey) return;
    lastPushedSync.set(project.id, pushKey);
    const login = currentUser().login;
    const snapshot = localSnapshot(memory, login, project.id);
    const payload = { type: "history", projectId: target, login, snapshot };
    if (sendToHost(payload)) return;
    try {
      await fetchHost(room.url, "/api/room/history", {
        method: "POST",
        timeoutMs: 8000,
        body: JSON.stringify(payload),
      });
    } catch {
      lastPushedSync.delete(project.id);
    }
  }

  async function pushRoomHistory(room, project) {
    return pushRoomSnapshot(room, project, { force: false });
  }

  function notifyCollisionMetrics(project) {
    if (!project?.id) return;
    const room = loadRoom(project.path);
    const login = currentUser().login || "local";
    const merged = mergeCollisionStats(loadMemory(project.id), { localLogin: login, projectId: project.id });
    sse.emit("metrics", { workspaceId: project.id, collisions: merged });
    if (room?.role === "host" && room.url) queueRoomState(project);
    else if (room?.role === "guest" && room.url) pushRoomSnapshot(room, project, { force: true }).catch(() => undefined);
  }

  function bumpCollision(projectId, kind, detail = {}) {
    recordCollision(projectId, kind, detail);
    const project = loadRegistry().projects.find((p) => p.id === projectId);
    if (project) notifyCollisionMetrics(project);
  }

  async function pullRoomHistory(room, project) {
    if (room?.role !== "guest" || !room.url || !room.hostProjectId || !project) return;
    const login = currentUser().login;
    const body = await fetchHost(
      room.url,
      `/api/room/state?projectId=${encodeURIComponent(room.hostProjectId)}&exclude=${encodeURIComponent(login)}`
    ).then((r) => r.json());
    if (body?.ok) savePeerSnapshot(project.id, "host", body, body.hostLogin || "host");
  }

  app.get("/api/health", (_req, res) => {
    const session = loadSession();
    res.json({
      ok: true,
      version: VERSION,
      coordinatorPort: coordPort,
      auth: Boolean(session.userId),
      room: publicRoom(loadRoom()),
    });
  });

  app.get("/api/session", (_req, res) => {
    const reg = loadRegistry();
    const session = loadSession();
    const user = session.userId ? reg.users.find((u) => u.id === session.userId) || null : null;
    res.json({
      user,
      users: reg.users,
      projectId: session.projectId || currentProject()?.id,
      oauthConfigured: Boolean(process.env.GITHUB_CLIENT_ID),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const reg = loadRegistry();
    const login = req.body?.login;
    const user = reg.users.find((u) => u.login === login) || reg.users[0];
    const session = { ...loadSession(), userId: user.id, login: user.login };
    saveSession(session);
    sse.emit("presence", { workspaceId: currentProject()?.id, user });
    res.json({ user });
  });

  app.get("/api/auth/github", (req, res) => {
    const redirect = `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
    const url = authorizeUrl(redirect);
    if (!url) return res.status(501).json({ error: "oauth_not_configured", hint: "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET" });
    res.redirect(url);
  });

  app.get("/api/auth/github/callback", async (req, res) => {
    const redirect = `${req.protocol}://${req.get("host")}/api/auth/github/callback`;
    try {
      const result = await exchangeCode(req.query.code, redirect);
      if (result.error) return res.status(400).json(result);
      const reg = loadRegistry();
      let user = reg.users.find((u) => u.login === result.user.login);
      if (!user) {
        user = result.user;
        reg.users.push(user);
        saveRegistry(reg);
      }
      saveSession({ ...loadSession(), userId: user.id, login: user.login });
      res.redirect(UI_ORIGIN);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post("/api/auth/logout", (_req, res) => {
    saveSession({ userId: null, login: null, projectId: loadSession().projectId });
    res.json({ ok: true });
  });

  app.get("/api/projects", (_req, res) => {
    res.json({ projects: loadRegistry().projects });
  });

  app.post("/api/projects", async (req, res) => {
    const { name, path: workspacePath, remoteUrl, mode } = req.body || {};
    try {
      let project;
      if (mode === "clone") {
        if (!remoteUrl) return res.status(400).json({ error: "remoteUrl required" });
        const out = await cloneRepo(remoteUrl, workspacePath);
        project = out.project;
        if (name && name !== project.name) {
          project.name = name;
          const reg = loadRegistry();
          const row = reg.projects.find((p) => p.id === project.id);
          if (row) row.name = name;
          saveRegistry(reg);
        }
      } else {
        if (!workspacePath) return res.status(400).json({ error: "path required" });
        project = addLocal(workspacePath, name);
      }
      watcher.watch(project.path, project.id);
      sse.emit("projects", { projects: loadRegistry().projects });
      res.status(201).json({ project });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  app.get("/api/projects/:id", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    res.json({ project });
  });

  app.patch("/api/projects/:id", (req, res) => {
    const reg = loadRegistry();
    const project = reg.projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    if (req.body?.name) project.name = req.body.name;
    saveRegistry(reg);
    res.json({ project });
  });

  function stopTranscriptWatch(projectId) {
    const state = transcriptWatchers.get(projectId);
    if (state && typeof state === "object" && state.timer) {
      try {
        clearTimeout(state.timer);
      } catch {
        /* ignore */
      }
    }
    transcriptWatchers.delete(projectId);
    lastIngest.delete(projectId);
    ingestAgain.delete(projectId);
    ownership.delete(projectId);
  }

  app.delete("/api/projects/:id", (req, res) => {
    const mode = String(req.query.mode || req.body?.mode || "leave");
    const reply = (nextId) => res.json({ ok: true, mode, nextId: nextId || null });
    try {
      const reg = loadRegistry();
      const idx = reg.projects.findIndex((p) => p.id === req.params.id);
      if (idx < 0) return res.status(404).json({ ok: false, error: "not_found", nextId: null });
      const project = reg.projects[idx];
      try {
        if (project.path) watcher.unwatch(project.path);
      } catch {
        /* ignore */
      }
      stopTranscriptWatch(project.id);
      // Leave keeps workspace files on disk. Remove only drops Relay's own
      // metadata — never the checkout — so a missing path/room cannot 500.
      reg.projects.splice(idx, 1);
      saveRegistry(reg);
      if (mode === "remove") {
        try {
          fs.rmSync(projectDir(project.id), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
      const session = loadSession();
      if (session.projectId === project.id) {
        session.projectId = reg.projects[0]?.id || null;
        saveSession(session);
      }
      try {
        sse.emit("projects", { projects: reg.projects });
      } catch {
        /* ignore */
      }
      return reply(session.projectId || reg.projects[0]?.id || null);
    } catch {
      // Last-ditch unregister so leave/remove never surface as a 500.
      try {
        const reg = loadRegistry();
        const idx = reg.projects.findIndex((p) => p.id === req.params.id);
        if (idx >= 0) {
          const project = reg.projects[idx];
          stopTranscriptWatch(project.id);
          try {
            if (project.path) watcher.unwatch(project.path);
          } catch {
            /* ignore */
          }
          reg.projects.splice(idx, 1);
          saveRegistry(reg);
          const session = loadSession();
          if (session.projectId === project.id) {
            session.projectId = reg.projects[0]?.id || null;
            saveSession(session);
          }
          return reply(session.projectId || reg.projects[0]?.id || null);
        }
        return reply(loadSession().projectId || loadRegistry().projects[0]?.id || null);
      } catch {
        return reply(null);
      }
    }
  });

  app.post("/api/projects/:id/select", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    saveSession({ ...loadSession(), projectId: project.id });
    res.json({ project, dashboard: buildDashboard(project) });
  });

  app.post("/api/projects/:id/sync", async (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const memory = await syncTranscriptsQueued(project, {
      ownerLogin: loadSession().login || "local",
    });
    project.lastSyncAt = Date.now();
    const reg = loadRegistry();
    const idx = reg.projects.findIndex((p) => p.id === project.id);
    reg.projects[idx] = project;
    saveRegistry(reg);
    Promise.all([
      pushLocalEdits(project.path, project.id, memory),
      pullCentralChanges(project.path),
    ])
      .then(() => sse.emit("history", { workspaceId: project.id, lastSyncAt: project.lastSyncAt }))
      .catch(() => sse.emit("history", { workspaceId: project.id, lastSyncAt: project.lastSyncAt }));
    publishGraph(project);
    res.json({
      ok: true,
      lastSyncAt: project.lastSyncAt,
      chats: (memory.chats || []).length,
      history: (memory.history || []).length,
    });
  });

  app.get("/api/projects/:id/dashboard", async (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const room = loadRoom(project.path);
    // A room is the only thing that makes this workspace anything other than
    // local: everything below (peer history, shared locks, remote presence) is
    // skipped entirely when no tunnel is joined.
    if (room?.url) {
      syncRoomLocks();
      const live = room.role === "guest" ? hostWireOpen() : Boolean(wss && [...wss.clients].some((c) => c.readyState === 1));
      if (!live) {
        // Do not block the dashboard on ngrok. Sync already owns transcripts;
        // waiting here is what made Coordinator freeze and then go blank.
        pullRoomHistory(room, project).catch(() => undefined);
        pushRoomHistory(room, project).catch(() => undefined);
      }
    }
    const dashboard = buildDashboard(project);
    dashboard.locks = locksFor({ id: project.id, path: project.path });
    dashboard.reads = readsFor({ id: project.id, path: project.path });
    const graph = fs.existsSync(project.path) ? graphFor(project.path) : null;
    // Released rows are on the list for the activity trail only — treating them
    // as held would paint the dependency graph with locks nobody is holding.
    const lockedFiles = dashboard.locks
      .filter((l) => !l.released)
      .map((l) => (l.filePath.includes("::") ? l.filePath.split("::")[1] : l.filePath));
    dashboard.graph = graph
      ? graph.snapshot(lockedFiles)
      : { nodes: [], edges: [], cycles: [], unresolvable: [], fileCount: 0, edgeCount: 0, lockDepth: 1 };
    const mem = loadMemory(project.id);
    dashboard.patches = patchRows(mem.patches || mem.edits || []);
    dashboard.lastAppliedLamport = mem.lastAppliedLamport || 0;
    let roomMembers = [];
    if (room?.role === "host") {
      // Re-upserting on every poll is what keeps the host's own lastSeen fresh;
      // membersView reads it as online/offline, so skipping it when the row
      // already exists made the host show as offline in its own room after 45s.
      saveRoom(upsertMember(room, { ...currentUser(), ...activeAgent(project.id) }, "host"), project.path);
      roomMembers = membersView(loadRoom(project.path));
    }
    if (room?.role === "guest" && room.url) {
      roomMembers = membersView(loadRoom(project.path));
      announceToHost(room)
        .then((hello) => {
          const roster = Array.isArray(hello?.members) && hello.members.length ? hello.members : null;
          if (roster) rememberRoster(project.path, roster);
        })
        .catch(() => {
          refreshGuestRoom(room)
            .then((next) => {
              if (next?.url && next.url !== room.url) {
                connectHostPatches(next);
                connectHostControl(next);
              }
            })
            .catch(() => undefined);
        });
      if (room.hostProjectId) {
        fetchHost(room.url, `/api/projects/${room.hostProjectId}/graph`)
          .then((r) => r.json())
          .then((remoteGraph) => {
            if (remoteGraph?.nodes) sse.emit("graph", { workspaceId: project.id, graph: remoteGraph });
          })
          .catch(() => undefined);
      }
    }
    // Projects registered before remoteUrl auto-detection existed (or via
    // "Add local repository", which used to always store null) never got a
    // remoteUrl — backfill it once from the workspace's own git remote so
    // the GitHub-collaborators lookup below has something to work with.
    if (!project.remoteUrl) {
      const detected = detectRemoteUrl(project.path);
      if (detected) {
        project.remoteUrl = detected;
        const reg = loadRegistry();
        const idx = reg.projects.findIndex((p) => p.id === project.id);
        if (idx >= 0) {
          reg.projects[idx] = project;
          saveRegistry(reg);
        }
      }
    }
    if (room?.url) {
      const me = currentUser();
      const myRole = room.role === "host" ? "host" : "guest";
      const mine = { ...me, role: myRole, online: true, ...activeAgent(project.id) };
      const rest = roomMembers.filter((c) => !sameLogin(c.login, me.login));
      const previous = roomMembers.find((c) => sameLogin(c.login, me.login));
      roomMembers = [{ ...previous, ...mine }, ...rest];
    }
    let ghCollaborators = peekCollaborators(project.remoteUrl) || [];
    fetchGithubCollaborators(project.remoteUrl).catch(() => []);
    dashboard.collaborators = overlayTeam(ghCollaborators, roomMembers);
    // hostReachable lets the Coordinator board say "the host is not answering"
    // instead of rendering the same empty state it shows when simply nobody is
    // editing — the two look identical from the guest's side otherwise.
    const health = roomLocks.health;
    dashboard.room = publicRoom(room)
      ? { ...publicRoom(room), hostReachable: health.reachable, lastHostContactAt: health.lastContactAt }
      : null;
    // Only the host manages invites, and only its own Mission Control sees them.
    dashboard.invites = room?.role === "host" && !isRemoteRequest(req) ? inviteView(room) : [];
    dashboard.openRooms =
      !isRemoteRequest(req) && discoverState.key === repoKeyFromRemote(project.remoteUrl) ? discoverState.rooms : [];
    if (!isRemoteRequest(req) && room?.role !== "host") {
      refreshOpenRooms(project)
        .then((rooms) => {
          if (rooms.length) sse.emit("presence", { workspaceId: project.id, openRooms: true });
        })
        .catch(() => undefined);
    }
    res.json(dashboard);
  });

  app.get("/api/projects/:id/graph", requireRoomMember, (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const g = rebuild(project.path) || graphFor(project.path);
    const lockedFiles = lockTable.list({ id: project.id, path: project.path }).map((l) =>
      l.filePath.includes("::") ? l.filePath.split("::")[1] : l.filePath
    );
    res.json(g ? g.snapshot(lockedFiles) : { nodes: [], edges: [] });
  });

  app.get("/api/projects/:id/history", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const memory = loadMemory(project.id);
    delete memory.ir;
    res.json({
      history: memory.history || [],
      chats: memory.chats || [],
      timeline: memory.timeline || [],
    });
  });

  app.get("/api/projects/:id/conflicts", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    res.json({ conflicts: detectConflicts(loadMemory(project.id)) });
  });

  app.post("/api/ingest-stop", async (req, res) => {
    const { workspacePath, agent, ownerLogin, sessionId, messages, edits, transcript_path } = req.body || {};
    const project = ensureWorkspace(workspacePath);
    if (!project) return res.status(400).json({ error: "workspace_path_required" });
    const login = ownerLogin || loadSession().login || "local";
    const memory = await syncTranscriptsQueued(project, {
      ownerLogin: login,
      hint: {
        agent,
        sessionId,
        conversationId: req.body?.conversationId,
        transcript_path,
      },
    });
    if (!(memory.history || []).length && ((messages && messages.length) || (edits && edits.length))) {
      const harvested = harvest({
        transcript_path,
        sessionId,
        conversationId: req.body?.conversationId,
      });
      appendStopTurn(project.id, {
        agent: agent || "Agent",
        ownerLogin: login,
        sessionId,
        messages: (messages && messages.length ? messages : harvested.messages) || [],
        edits: (edits && edits.length ? edits : harvested.edits) || [],
      });
    }
    sse.emit("history", { workspaceId: project.id, lastSyncAt: Date.now() });
    pushLocalEdits(project.path, project.id, loadMemory(project.id))
      .then(() => pullCentralChanges(project.path))
      .catch(() => undefined);
    pushRoomHistory(loadRoom(project.path), project).catch(() => undefined);
    publishGraph(project);
    res.json({
      ok: true,
      harvested: Boolean((memory.history || []).length),
      chats: (memory.chats || []).length,
      history: (memory.history || []).length,
    });
  });

  app.post("/api/handshake", (req, res) => {
    const { projectId, agent } = req.body || {};
    const project = loadRegistry().projects.find((p) => p.id === projectId) || currentProject();
    if (!project) return res.status(404).json({ error: "no_project" });
    const memory = loadMemory(project.id);
    const row = memory.agents.find((a) => a.label === agent || a.id === agent);
    if (row) {
      row.status = "handshaking";
      row.lastActiveAt = Date.now();
    }
    saveMemory(project.id, memory);
    const token = id("hs");
    try {
      fs.writeFileSync(
        path.join(project.path, ".relay", `.handshake_${(agent || "agent").replace(/\s+/g, "_")}`),
        token
      );
    } catch {
      fs.mkdirSync(path.join(homeRelayDir(), "handshakes"), { recursive: true });
    }
    sse.emit("agents", { workspaceId: project.id, agents: memory.agents });
    res.json({ ok: true, status: "handshaking", token });
  });

  app.post("/api/connect", (req, res) => {
    const { projectId, agent } = req.body || {};
    const project = loadRegistry().projects.find((p) => p.id === projectId) || currentProject();
    const memory = loadMemory(project.id);
    const row = memory.agents.find((a) => a.label === agent || a.id === agent);
    if (row) {
      row.status = "connected";
      row.lastActiveAt = Date.now();
      row.sessionId = id("sess").slice(-5);
    }
    saveMemory(project.id, memory);
    watcher.watch(project.path, project.id);
    sse.emit("agents", { workspaceId: project.id, agents: memory.agents });
    res.json({ ok: true, status: "connected", agent: row });
  });

  app.get("/api/memory", (req, res) => {
    const projectId = req.query.projectId || currentProject()?.id;
    res.json(loadMemory(projectId));
  });

  app.get("/api/locks", requireRoomMember, (req, res) => {
    try {
      const scope = lockScope(req.query.projectId || currentProject()?.id);
      res.json({
        locks: locksFor(scope),
        reads: readsFor(scope),
        raw: scope ? lockTable.status(scope) : { locks: {} },
      });
    } catch (err) {
      console.warn(`[relay] /api/locks: ${err.message || err}`);
      res.json({ locks: [], reads: [], raw: { locks: {} } });
    }
  });

  app.get("/api/locks/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const workspaceId = req.query.projectId;
    const send = () => {
      try {
        const scope = lockScope(workspaceId);
        const payload = {
          locks: locksFor(scope),
          reads: readsFor(scope),
          raw: scope ? lockTable.status(scope) : { locks: {} },
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        console.warn(`[relay] locks/stream: ${err.message || err}`);
      }
    };
    send();
    const listener = () => send();
    lockTable.on("change", listener);
    roomLocks.on("change", listener);
    req.on("close", () => {
      lockTable.off("change", listener);
      roomLocks.off("change", listener);
    });
  });

  app.get("/api/events", (req, res) => {
    const workspaceId = req.query.projectId;
    const session = loadSession();
    const userId = req.headers["x-relay-user"] || session.login;
    if (workspaceId && userId) {
      const out = presence.join(workspaceId, userId);
      if (out.escalated) {
        const scope = lockScope(workspaceId);
        for (const lock of lockTable.list(scope || workspaceId)) lockTable.escalateRegister(lock);
        // Merged view, not the raw table: on a guest the local table is empty
        // and this would blank the board for every viewer of the workspace.
        sse.emit("locks", { workspaceId, locks: locksFor(scope), reads: readsFor(scope) });
      }
      sse.emit("presence", { workspaceId, userId, count: out.count, escalated: out.escalated });
    }
    sse.subscribe(res, { workspaceId });
    req.on("close", () => {
      if (workspaceId && userId) presence.leave(workspaceId, userId);
    });
  });

  app.post("/api/ensure-workspace", (req, res) => {
    const project = ensureWorkspace(req.body?.workspacePath);
    if (!project) return res.status(400).json({ error: "workspace_path_required" });
    res.json({ ok: true, project });
  });

  app.post("/api/heartbeat", (req, res) => {
    res.json(lockTable.heartbeat(req.body || {}));
  });

  /**
   * Scopes lock traffic arriving from a remote room member to the host's own
   * workspace path.
   *
   * The lock table keys every entry by absolute workspace path, and no two
   * machines agree on that path — Alice's `C:/projects/repo` and Bob's
   * `/home/bob/repo` produce different keys for the same file, so both agents
   * are granted the same lock and the coordinator arbitrates nothing.
   *
   * coordinator/client.js already rewrites the path on the way out, but that
   * only holds when the peer is on a current build and its agent was launched
   * in exactly the mirrored root; it no-ops for a subdirectory, or for a room
   * that predates hostWorkspacePath. A room shares exactly one project, so any
   * lock traffic from a member is about that project by definition — deciding
   * that here makes the shared mutex independent of the peer's version and of
   * where it happened to start its agent.
   */
  function roomScopedBody(req, body) {
    // A caller holding a member token is a peer no matter which interface it
    // arrived on; anything else is this machine's own agent, already using the
    // host's path.
    if (!req.roomMember && !isRemoteRequest(req)) return body;
    const room = loadRoom();
    if (!room?.url || room.role !== "host") return body;
    const shared = loadRegistry().projects.find((p) => p.id === room.hostProjectId) || currentProject();
    if (!shared?.path) return body;
    if (normalizeCompare(body?.workspaceId) === normalizeCompare(shared.path)) return body;
    return { ...body, workspaceId: shared.path, peerWorkspacePath: body?.workspaceId || null };
  }

  // The same identity rule the control socket applies, for the HTTP fallback a
  // guest uses when the tunnel is down. Both paths must stamp a peer's agentId
  // identically or a failover would let one agent hold the same file twice.
  function httpLockSession(req) {
    const remote = Boolean(req.roomMember) || isRemoteRequest(req);
    return { remote, login: req.roomMember?.login || null, roomId: loadRoom()?.roomId || null };
  }

  app.post("/api/coord/claim", requireRoomMember, async (req, res) => {
    const room = loadRoom();
    const body = roomScopedBody(req, req.body || {});
    if (room?.role === "guest") {
      const payload = {
        ...body,
        workspaceId: room.hostWorkspacePath || body.workspaceId,
        peerWorkspacePath: body.workspaceId,
      };
      try {
        // Never claim across an in-flight replay. A release queued during the
        // outage and this claim ride the same socket, and the host's `release`
        // only checks `sameOwner` — so a claim that overtakes the replay is
        // granted and then quietly released out from under the agent by its own
        // stale release. Letting the queue drain first makes the order the one
        // the agent actually meant.
        await roomControl.settled();
        const result = await roomControl.rpc("claim", payload);
        const answer = { ...(result || { allowed: false }), source: "host" };
        return res.status(answer.allowed ? 200 : 409).json(answer);
      } catch {
        // Tunnel down. The local table is NOT the shared mutex, and it does not
        // even mirror it: host lock pushes land in `roomLocks` for the board,
        // never in `lockTable`. Granting a write lock from it would not be
        // optimistic, it would be uninformed — the file another member is
        // holding looks free here every time. Say so instead of inventing a
        // grant the room never issued, and let the caller drop down to room
        // HTTP, which is a different wire and may well still be up.
        if ((body.mode || "write") !== "read") {
          return res.status(503).json({
            allowed: false,
            degraded: true,
            source: "local_fallback",
            reason: "control_offline",
            detail: "Host unreachable — this claim was never adjudicated by the room.",
          });
        }
        /* a read is advisory and cannot corrupt anything: record it locally */
      }
    }
    const scoped = sanitizeLockBody(body, httpLockSession(req));
    if (!scoped) return res.status(400).json({ allowed: false, error: "agent_required" });
    const files = Array.isArray(scoped.files) && scoped.files.length ? scoped.files : [scoped.file];
    const warnings = [];
    for (const file of files.filter(Boolean)) {
      const blocked = require("./lib/depGraph").softBlock(lockTable, scoped.workspaceId, scoped.agentId, file);
      const held = blocked?.file ? lockTable.getLock(blocked.file, scoped.workspaceId) : null;
      const { sameOwner } = require("./coordinator/lockTable");
      if (blocked && !(held && sameOwner(held.agentId, scoped.agentId))) {
        warnings.push(blocked.reason || blocked.holder || String(blocked));
      }
    }
    const result = lockTable.claim(scoped);
    if (warnings.length && result.allowed) result.warning = result.warning || warnings[0];
    if (!result.allowed) {
      const project = projectForPath(scoped.workspaceId) || currentProject();
      if (project?.id) {
        bumpCollision(project.id, "claim_blocked", {
          file: scoped.file,
          agentId: scoped.agentId,
          holder: result.holder,
          reason: result.reason,
        });
      }
    }
    res.status(result.allowed ? 200 : 409).json(result);
  });
  app.post("/api/coord/release", requireRoomMember, async (req, res) => {
    const room = loadRoom();
    const body = roomScopedBody(req, req.body || {});
    if (room?.role === "guest") {
      try {
        return res.json({ ...(await roomControl.rpc("release", body)), source: "host" });
      } catch {
        // Queue it: unlike a claim, a release is a statement of fact that stays
        // true. Without the replay the host holds the lock until its TTL runs
        // out, which is up to five minutes of a file nobody is actually editing.
        const queued = roomControl.enqueue("release", body);
        const local = runLockRpc("release", body, httpLockSession(req));
        return res.json({ ...local, source: "local_fallback", degraded: true, queued });
      }
    }
    res.json(runLockRpc("release", body, httpLockSession(req)));
  });
  app.post("/api/coord/heartbeat", requireRoomMember, async (req, res) => {
    const room = loadRoom();
    const body = roomScopedBody(req, req.body || {});
    if (room?.role === "guest") {
      try {
        return res.json({ ...(await roomControl.rpc("heartbeat", body, 400)), source: "host" });
      } catch {
        // Not queued on purpose: a heartbeat asserts liveness *now*, so a
        // replayed one would revive a lock the host has already expired.
        const local = runLockRpc("heartbeat", body, httpLockSession(req));
        return res.json({ ...local, source: "local_fallback", degraded: true });
      }
    }
    res.json(runLockRpc("heartbeat", body, httpLockSession(req)));
  });
  app.post("/api/coord/release-all", requireRoomMember, (req, res) => {
    const body = roomScopedBody(req, req.body || {});
    res.json(runLockRpc("release-all", body, httpLockSession(req)));
  });
  /**
   * A file was read, not claimed.
   *
   * Deliberately separate from /claim: this can never fail, never blocks, and
   * never denies anyone. It exists so the room can see the whole picture of what
   * every agent is working through, not just the few files being written.
   */
  app.post("/api/coord/read", requireRoomMember, async (req, res) => {
    const room = loadRoom();
    const body = roomScopedBody(req, req.body || {});
    let degradedRead = false;
    if (room?.role === "guest") {
      try {
        return res.json(
          await roomControl.rpc("read", { ...body, workspaceId: room.hostWorkspacePath || body.workspaceId }, 300)
        );
      } catch {
        /* tunnel down — record locally so this machine's board still lights up */
        degradedRead = true;
      }
    }
    const scoped = sanitizeLockBody(body, httpLockSession(req));
    if (!scoped) return res.json({ ok: false, error: "agent_required" });
    const files = (Array.isArray(scoped.files) && scoped.files.length ? scoped.files : [scoped.file]).filter(Boolean);
    const project = projectForPath(scoped.workspaceId);
    for (const file of files) {
      lockTable.noteRead({
        agentId: scoped.agentId,
        filePath: file,
        workspaceId: scoped.workspaceId,
        holder: scoped.holder,
      });
      const item = readActivity(scoped, file, project);
      sse.emit("activity", { workspaceId: project?.id, item });
      broadcastRoom({ type: "read", workspaceId: project?.id, item });
    }
    res.json({ ok: true, files, ...(degradedRead ? { source: "local_fallback", degraded: true } : {}) });
  });

  function readActivity(scoped, file, project) {
    const label = scoped.holder?.label || String(scoped.agentId).split(":")[0];
    return {
      id: `r_${project?.id || "ws"}_${file}_${scoped.agentId}_${Date.now()}`,
      kind: "read",
      agent: label,
      ownerLogin: scoped.holder?.login || loadSession().login || "local",
      mine: true,
      file,
      text: `${label} read ${file}`,
      ts: Date.now(),
    };
  }

  app.get("/api/coord/status", (req, res) => {
    const scope = lockScope(req.query.projectId);
    res.json(scope ? lockTable.status(scope) : lockTable.status());
  });

  // publicRoom strips invite and member-token hashes: this route answers
  // through the tunnel, and the raw room file is a credential store.
  app.get("/api/room", (_req, res) => res.json({ room: publicRoom(loadRoom()) }));
  app.post("/api/room/share", async (req, res) => {
    const project = currentProject();
    const existing = loadRoom(project?.path);
    if (existing?.role === "guest") {
      return res.status(409).json({
        error: "already_guest",
        hint: "Leave this room first if you want to host your own.",
      });
    }
    const result = await shareRoom(parsePort(process.argv), shareExtras(project));
    if (result.ok) {
      syncRoomLocks();
      result.warning = await publishAndWatch(result.room, project);
      result.room = publicRoom(loadRoom(project?.path));
    }
    res.status(result.ok ? 200 : 503).json(result);
  });

  // --- Room membership -----------------------------------------------------
  // Guests announce themselves on every dashboard poll; membersView treats a
  // member as online for 45s after its last hello, which is what drives the
  // online/offline dot in the Team tab on both sides of the tunnel.
  function hostRoomFor(projectId) {
    const project = projectId ? loadRegistry().projects.find((p) => p.id === projectId) : currentProject();
    const room = loadRoom(project?.path);
    return { project: project || currentProject(), room };
  }

  app.post("/api/room/hello", requireRoomMember, (req, res) => {
    const { project, room } = hostRoomFor(req.body?.hostProjectId);
    if (!room?.url) return res.status(409).json({ error: "no_room" });
    const user = req.body?.user;
    if (!user?.login) return res.status(400).json({ error: "user_required" });
    const next = upsertMember(room, user, req.body?.role === "host" ? "host" : "guest");
    // The host is a member of its own room; without this it never appears in
    // the roster a guest renders.
    upsertMember(next, { ...currentUser(), ...activeAgent(project?.id) }, "host");
    saveRoom(next, project?.path);
    sse.emit("presence", { workspaceId: project?.id, userId: user.login });
    res.json({
      ok: true,
      members: membersView(next),
      hostProjectId: room.hostProjectId || project?.id || null,
      hostWorkspacePath: room.hostWorkspacePath || project?.path || null,
      hostLogin: currentUser().login,
      project: project
        ? { id: project.id, name: project.name, pathName: path.basename(project.path), remoteUrl: project.remoteUrl }
        : null,
    });
  });

  // Issuing and revoking invites is the host's own privilege. These routes are
  // reachable through the tunnel like everything else, so a member must not be
  // able to call them and mint credentials for others.
  function requireLocal(req, res, next) {
    if (isRemoteRequest(req)) return res.status(403).json({ error: "host_only" });
    return next();
  }

  function inviteLink(room, code, project) {
    const base = String(room.url || "").replace(/\/$/, "");
    const u = new URL(`${base}/`);
    u.searchParams.set("relay_invite", code);
    const host = room.hostLogin || currentUser().login;
    const repo = room.repoKey || repoKeyFromRemote(project?.remoteUrl);
    if (host) u.searchParams.set("relay_host", host);
    if (repo) u.searchParams.set("relay_repo", repo);
    if (room.roomId) u.searchParams.set("relay_room", room.roomId);
    return u.toString();
  }

  async function ensureHosting(project) {
    const existing = loadRoom(project?.path);
    if (existing?.role === "guest") {
      return {
        ok: false,
        status: 409,
        error: "already_guest",
        hint: "Leave this room first if you want to host your own.",
      };
    }
    if (existing?.url && existing.role === "host") return { ok: true, room: existing, warning: null };
    const result = await shareRoom(parsePort(process.argv), shareExtras(project));
    if (!result.ok) return { ...result, status: 503 };
    syncRoomLocks();
    const warning = await publishAndWatch(result.room, project);
    return { ok: true, room: loadRoom(project?.path), warning };
  }

  app.post("/api/room/invite", requireLocal, async (req, res) => {
    const project = currentProject();
    const hosted = await ensureHosting(project);
    if (!hosted.ok) return res.status(hosted.status || 409).json(hosted);
    const room = hosted.room;
    const login = normLogin(req.body?.login);
    if (!login) return res.status(400).json({ error: "login_required" });
    // Warn — but do not block — when the invitee is not on the repo's
    // collaborator list. The host may be inviting someone they are about to add,
    // and the same check runs again at redeem time, which is what actually
    // decides admission.
    const check = await collaboratorCheck(project, login);
    const { ok, invite, code, error } = createInvite(room, { login, invitedBy: currentUser().login });
    if (!ok) return res.status(400).json({ error });
    saveRoom(room, project?.path);
    const warning = (await publishAndWatch(room, project)) || hosted.warning;
    res.status(201).json({
      ok: true,
      invite: inviteView(room).find((i) => i.id === invite.id),
      code,
      link: inviteLink(room, code, project),
      collaborator: check,
      warning,
      room: publicRoom(loadRoom(project?.path)),
    });
  });

  app.get("/api/room/invites", requireLocal, (req, res) => {
    const room = loadRoom(currentProject()?.path);
    res.json({ invites: room ? inviteView(room) : [], open: Boolean(room?.open) });
  });

  app.post("/api/room/invites/:id/revoke", requireLocal, (req, res) => {
    const project = currentProject();
    const room = loadRoom(project?.path);
    if (!room?.url) return res.status(409).json({ error: "not_hosting" });
    const result = revokeInvite(room, req.params.id);
    if (!result.ok) return res.status(404).json(result);
    saveRoom(room, project?.path);
    res.json({ ok: true, invites: inviteView(room) });
  });

  app.post("/api/room/kick", requireLocal, (req, res) => {
    const project = currentProject();
    const room = loadRoom(project?.path);
    if (!room?.url) return res.status(409).json({ error: "not_hosting" });
    const login = normLogin(req.body?.login);
    if (!login) return res.status(400).json({ error: "login_required" });
    revokeMember(room, login);
    saveRoom(dropMember(room, login), project?.path);
    sse.emit("presence", { workspaceId: project?.id, userId: login, left: true });
    emitNotice(
      {
        type: "left",
        key: `left:${room.roomId || "room"}:${String(login).toLowerCase()}`,
        title: `@${login} left the room`,
        body: "Removed from the shared room — they stay on the GitHub team list.",
        workspaceId: project?.id || null,
        payload: { login },
      },
      { revive: true }
    );
    res.json({ ok: true, members: membersView(loadRoom(project?.path)), invites: inviteView(room) });
  });

  // The one room route a non-member may call, and only with a valid invite code.
  // Success mints the member token every other room request requires.
  app.post("/api/room/redeem", async (req, res) => {
    const project = currentProject();
    const room = loadRoom(project?.path);
    if (!room?.url || room.role !== "host") return res.status(409).json({ error: "not_hosting" });
    const user = req.body?.user;
    if (!user?.login) return res.status(400).json({ error: "user_required" });

    if (!room.open) {
      const code = req.body?.code;
      const proofGistId = req.body?.proofGistId;
      if (!code) {
        if (!proofGistId || !room.roomId || !room.nonce) {
          return res.status(403).json({
            error: "invite_required",
            hint: "This room is invite-only. Ask the host to invite you from the Team tab.",
          });
        }
        const proof = await verifyProof({
          gistId: proofGistId,
          roomId: room.roomId,
          nonce: room.nonce,
          login: user.login,
        });
        if (!proof.ok) {
          return res.status(403).json({
            error: proof.reason,
            hint: "Could not verify your GitHub identity. Ask the host to invite you from the Team tab.",
          });
        }
      }
      const redeemed = redeemInvite(room, code, user.login);
      if (!redeemed.ok) {
        return res.status(403).json({
          error: redeemed.reason,
          invitedLogin: redeemed.invitedLogin,
          hint:
            redeemed.reason === "invite_wrong_user"
              ? `That invite was issued to @${redeemed.invitedLogin}.`
              : "Ask the host to invite you from the Team tab.",
        });
      }
      const check = await collaboratorCheck(project, user.login);
      if (!check.allowed) {
        return res.status(403).json({
          error: "not_a_collaborator",
          hint: `@${user.login} is not a collaborator on this repository.`,
        });
      }
      if (!redeemed.rejoin) markAccepted(redeemed.invite, user.login);
    }

    const token = issueMemberToken(room, user.login);
    upsertMember(room, user, "guest");
    upsertMember(room, { ...currentUser(), ...activeAgent(project?.id) }, "host");
    saveRoom(room, project?.path);
    sse.emit("presence", { workspaceId: project?.id, userId: user.login });
    console.log(`[relay-room] @${user.login} joined the room`);
    emitNotice(
      {
        type: "joined",
        key: `joined:${room.roomId || "room"}:${String(user.login).toLowerCase()}`,
        title: `@${user.login} joined the room`,
        body: `They're in ${project?.name || "this workspace"} with you.`,
        workspaceId: project?.id || null,
        payload: { login: user.login, roomId: room.roomId || null },
      },
      { revive: true }
    );
    res.json({
      ok: true,
      token,
      roomId: room.roomId || null,
      members: membersView(room),
      hostProjectId: room.hostProjectId || project?.id || null,
      hostWorkspacePath: room.hostWorkspacePath || project?.path || null,
      hostLogin: currentUser().login,
      project: project
        ? { id: project.id, name: project.name, pathName: path.basename(project.path), remoteUrl: project.remoteUrl }
        : null,
    });
  });

  app.get("/api/room/members", requireRoomMember, (req, res) => {
    const { room } = hostRoomFor(req.query.projectId);
    res.json({ members: membersView(room) });
  });

  app.post("/api/room/bye", requireRoomMember, (req, res) => {
    const { project, room } = hostRoomFor(req.body?.hostProjectId);
    if (!room?.url || !req.body?.login) return res.json({ ok: true });
    saveRoom(dropMember(room, req.body.login), project?.path);
    sse.emit("presence", { workspaceId: project?.id, userId: req.body.login, left: true });
    emitNotice(
      {
        type: "left",
        key: `left:${room.roomId || "room"}:${String(req.body.login).toLowerCase()}`,
        title: `@${req.body.login} left the room`,
        body: "They disconnected from the shared coordinator.",
        workspaceId: project?.id || null,
      },
      { revive: true }
    );
    res.json({ ok: true });
  });

  // --- Shared chat history --------------------------------------------------
  // The aggregate a guest pulls: this machine's own transcripts plus every other
  // member's, so guests see each other and not only the host.
  app.get("/api/room/state", requireRoomMember, (req, res) => {
    const project = req.query.projectId
      ? loadRegistry().projects.find((p) => p.id === req.query.projectId) || currentProject()
      : currentProject();
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const login = currentUser().login || "local";
    const memory = loadMemory(project.id);
    const view = mergeRoomViews(memory, { exclude: req.query.exclude || null });
    res.json({
      ok: true,
      hostLogin: login,
      projectId: project.id,
      lastTranscriptSyncAt: memory.lastTranscriptSyncAt || 0,
      chats: view.chats,
      timeline: view.timeline,
      activity: view.activity,
      edits: view.edits,
      agents: view.agents,
      stats: memory.stats || {},
      roomCollisions: mergeCollisionStats(memory, { localLogin: login, exclude: req.query.exclude || null, projectId: project.id }),
    });
  });

  app.post("/api/room/history", requireRoomMember, (req, res) => {
    const project = req.body?.projectId
      ? loadRegistry().projects.find((p) => p.id === req.body.projectId) || currentProject()
      : currentProject();
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const login = String(req.body?.login || "").trim();
    if (!login) return res.status(400).json({ error: "login_required" });
    ingestPeerHistory(login, req.body?.snapshot, project);
    res.json({ ok: true });
  });
  // --- MCP over HTTP ---------------------------------------------------------
  // The same tool surface `backend/mcp/server.js` serves over stdio, reachable
  // through the room tunnel — so an agent on another machine, or one with no
  // relay installed at all, can read what the room knows. Stateless: no session
  // id is issued, so there is nothing to expire and nothing to clean up.
  //
  // A caller that arrived from off-machine gets the read-only subset. Writing a
  // lock or a Central event as this process would attribute it to the host's
  // workspace and the host's user, and would put a second writer on the lock
  // table; guests do those through their own relay, which is also the path that
  // still works when the tunnel does not.
  app.post("/mcp", requireRoomMember, async (req, res) => {
    const project = currentProject();
    const remote = isRemoteRequest(req);
    const viewer = req.roomMember?.login || null;
    const ctx = {
      workspace: project?.path,
      projectId: project?.id,
      agentId: `mcp:http:${viewer || (remote ? "guest" : "local")}`,
      user: currentUser().login,
      owner: currentUser().login,
      readOnly: remote,
      viewer,
    };
    const batch = Array.isArray(req.body);
    const messages = batch ? req.body : [req.body];
    const replies = [];
    for (const msg of messages) {
      try {
        const reply = await mcpRpc(msg, ctx);
        if (reply) replies.push({ jsonrpc: "2.0", id: reply.id, result: reply.result });
      } catch (err) {
        // A failed tool is a JSON-RPC error, not an HTTP one: the client is
        // still talking, and a 500 would make it drop the whole connection.
        replies.push({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32000, message: err.message } });
      }
    }
    // Nothing but notifications in the batch — the spec wants an empty 202.
    if (!replies.length) return res.status(202).end();
    res.json(batch ? replies : replies[0]);
  });

  // The optional server-to-client stream and the session teardown. Declining
  // both is allowed, and a client that gets 405 here simply stops asking.
  app.get("/mcp", (_req, res) => res.status(405).json({ error: "streaming_not_supported" }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ error: "stateless_no_sessions" }));

  app.post("/api/room/adopt", (req, res) => {
    const url = String(req.body?.url || "").replace(/\/$/, "");
    if (!url) return res.status(400).json({ error: "url required" });
    const project = currentProject();
    const room = saveRoom(
      upsertMember(
        {
          role: "host",
          url,
          hostProjectId: project?.id || null,
          hostWorkspacePath: project?.path || null,
          hostProjectName: project?.name || null,
          projectId: project?.id || null,
          projectPath: project?.path || null,
          startedAt: new Date().toISOString(),
          members: [],
        },
        currentUser(),
        "host"
      ),
      project?.path
    );
    syncRoomLocks();
    res.json({ ok: true, room });
  });
  // Where a guest's copy of the host's repo lands when it has no matching
  // workspace of its own.
  function defaultJoinDir(name) {
    return path.join(os.homedir(), "Documents", "Relay", String(name || "workspace").replace(/[<>:"|?*]/g, "-"));
  }

  // Resolves the workspace a joining guest will mirror into: an explicit path,
  // an existing workspace for the same repo, or a fresh folder named after the
  // host's. Registering it up front is what lets patches, locks and the seed all
  // agree on one target instead of falling back to "whatever is selected".
  function resolveJoinProject(hostMeta, explicitPath) {
    const reg = loadRegistry();
    if (explicitPath) {
      const resolved = normalizeWorkspaceRoot(explicitPath) || explicitPath;
      fs.mkdirSync(resolved, { recursive: true });
      return ensureWorkspace(resolved);
    }
    const match =
      (hostMeta.remoteUrl && reg.projects.find((p) => p.remoteUrl && p.remoteUrl === hostMeta.remoteUrl)) ||
      (hostMeta.name && reg.projects.find((p) => p.name === hostMeta.name)) ||
      (hostMeta.pathName && reg.projects.find((p) => path.basename(p.path) === hostMeta.pathName));
    if (match) return match;
    const target = defaultJoinDir(hostMeta.pathName || hostMeta.name);
    fs.mkdirSync(target, { recursive: true });
    return ensureWorkspace(target);
  }

  async function seedFromHost(url, hostProjectId, project) {
    const snap = await fetchHost(url, `/api/snapshot?full=1&projectId=${encodeURIComponent(hostProjectId || "")}`, {
      timeoutMs: SEED_TIMEOUT_MS,
    }).then((r) => r.json());
    applyingRemote.add(project.id);
    let written = [];
    let failed = [];
    try {
      ({ written, failed } = writeTree(project.path, snap.files || []));
    } finally {
      applyingRemote.delete(project.id);
    }
    // Record what we just wrote as known content, so the filesystem watcher does
    // not immediately publish the whole seeded tree back to the host as if the
    // guest had authored it.
    const session = loadSession();
    for (const file of written) {
      const patch = computePatch({
        workspacePath: project.path,
        file,
        agent: "seed",
        ownerLogin: session.login || "local",
        workspaceId: project.id,
      });
      if (patch) {
        patch.originId = originId();
        recordPatch(project.id, patch);
      }
    }
    return { files: written.length, failed: failed.length, truncated: Boolean(snap.truncated) };
  }

  // An invite link is the room URL plus a code, with host/repo/room stamped so
  // a guest can still find the room after ngrok recycles the URL.
  function decodeParam(value) {
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function splitInviteUrl(raw) {
    const text = String(raw || "").trim();
    const grab = (name) => {
      const m = text.match(new RegExp(`[?&#]${name}=([^&#\\s]+)`));
      return m ? decodeParam(m[1]) : null;
    };
    const code = grab("relay_invite");
    const host = grab("relay_host");
    const repo = grab("relay_repo");
    const roomId = grab("relay_room");
    let url = text;
    const first = text.search(/[?&#]relay_(invite|host|repo|room)=/);
    if (first >= 0) url = text.slice(0, first).replace(/[?#]$/, "").replace(/\/$/, "");
    if (!/^https?:\/\//i.test(url)) url = "";
    return { url, code, host, repo, roomId };
  }

  async function resolveJoinTarget(body) {
    const parsed = splitInviteUrl(body?.url);
    const code = body?.code || parsed.code;
    const hostLogin = body?.hostLogin || parsed.host;
    const repoKey = body?.repoKey || parsed.repo || repoKeyFromRemote(currentProject()?.remoteUrl);
    const roomId = body?.roomId || parsed.roomId;
    let url = parsed.url;
    if (!url && body?.url && /^https?:\/\//i.test(String(body.url).trim())) {
      url = String(body.url).replace(/\/$/, "");
    }
    const lookup = () =>
      findSignal({
        gistId: body?.gistId,
        hostLogin,
        repoKey,
        roomId,
      });
    let signal = null;
    if (url) {
      try {
        await fetchHost(url, "/api/health", { token: null, timeoutMs: 4000 });
      } catch {
        signal = await lookup().catch(() => null);
        if (signal?.url) url = signal.url;
        else {
          const err = new Error("unreachable");
          err.status = 502;
          throw err;
        }
      }
    } else {
      signal = await lookup();
      if (!signal?.url) return { error: "room_not_found", hint: "The host is not sharing right now." };
      url = signal.url;
    }
    if (!signal && (hostLogin || body?.gistId)) {
      signal = await lookup().catch(() => null);
    }
    return { url, code, signal, hostLogin, repoKey, roomId };
  }

  app.get("/api/room/discover", requireLocal, async (_req, res) => {
    const project = currentProject();
    try {
      const rooms = await refreshOpenRooms(project);
      res.json({ ok: true, rooms });
    } catch (err) {
      res.json({ ok: false, rooms: [], error: String(err.message || err) });
    }
  });

  app.get("/api/notices", requireLocal, (_req, res) => {
    res.json({ ok: true, notices: listNotices(), unread: unreadCount() });
  });

  app.post("/api/notices/read-all", requireLocal, (_req, res) => {
    res.json({ ok: true, notices: markAllRead(), unread: 0 });
  });

  app.post("/api/notices/:id/read", requireLocal, (req, res) => {
    markRead(req.params.id);
    res.json({ ok: true, notices: listNotices(), unread: unreadCount() });
  });

  app.post("/api/notices/dismiss", requireLocal, (req, res) => {
    if (req.body?.id) dismissNotice(req.body.id);
    else if (req.body?.key) dismissByKey(req.body.key);
    res.json({ ok: true, notices: listNotices(), unread: unreadCount() });
  });

  app.post("/api/room/join", async (req, res) => {
    const target = await resolveJoinTarget(req.body || {}).catch((err) => ({ error: "unreachable", detail: String(err.message || err) }));
    if (target.error) {
      return res.status(target.error === "room_not_found" ? 404 : 502).json(target);
    }
    const { url, code, signal } = target;
    const seed = req.body?.seed !== false;
    try {
      // /api/health needs no credential, and tells us whether this host is even
      // running a room before we spend an invite on it.
      const health = await fetchHost(url, "/api/health", { token: null }).then((r) => r.json());

      let proofGistId = null;
      try {
        if (signal?.nonce && signal?.roomId) {
          proofGistId = await createProof({
            roomId: signal.roomId,
            nonce: signal.nonce,
            login: currentUser().login,
          });
        }
      } catch {
        /* invite code still works without a proof gist */
      }

      // Redeem before anything else: until the host mints a member token, every
      // other room route answers 401 and there is nothing useful to do.
      let admission;
      try {
        admission = await fetchHost(url, "/api/room/redeem", {
          token: null,
          method: "POST",
          body: JSON.stringify({ code, user: currentUser(), proofGistId }),
        }).then((r) => r.json());
      } catch (err) {
        if (err.status === 403 || err.status === 409) {
          const detail = await fetch(`${url}/api/room/redeem`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "relay" },
            body: JSON.stringify({ code, user: currentUser(), proofGistId }),
          })
            .then((r) => r.json())
            .catch(() => ({}));
          return res.status(403).json({
            error: detail.error || "invite_required",
            hint: detail.hint || "This room is invite-only. Ask the host to invite you from the Team tab.",
          });
        }
        throw err;
      } finally {
        if (proofGistId) deleteGist(proofGistId).catch(() => undefined);
      }

      const hostProject = admission.project || null;
      const hostMeta = {
        remoteUrl: hostProject?.remoteUrl || null,
        name: hostProject?.name || null,
        pathName: hostProject?.pathName || hostProject?.name || null,
      };
      const project = resolveJoinProject(hostMeta, req.body?.path);
      if (!project) return res.status(400).json({ error: "no_local_workspace" });

      const room = saveRoom(
        {
          role: "guest",
          url,
          memberToken: admission.token || null,
          roomId: admission.roomId || signal?.roomId || null,
          signalGistId: signal?.gistId || null,
          repoKey: signal?.repoKey || repoKeyFromRemote(hostMeta.remoteUrl) || target.repoKey || null,
          hostProjectId: admission.hostProjectId || health.room?.hostProjectId || null,
          hostWorkspacePath: admission.hostWorkspacePath || health.room?.hostWorkspacePath || null,
          hostProjectName: hostMeta.name,
          hostLogin: admission.hostLogin || signal?.hostLogin || target.hostLogin || null,
          projectId: project.id,
          projectPath: project.path,
          startedAt: new Date().toISOString(),
          members: Array.isArray(admission.members) ? admission.members : [],
        },
        project.path
      );

      connectHostPatches(room);
      connectHostControl(room);
      syncRoomLocks();

      let seeded = null;
      if (seed) {
        try {
          seeded = await seedFromHost(url, room.hostProjectId, project);
        } catch (err) {
          seeded = { error: String(err.message || err) };
        }
      }

      // Uncommitted work the host has on top of the seed.
      const pulled = [];
      try {
        const snap = await fetchHost(url, "/api/snapshot", { timeoutMs: SEED_TIMEOUT_MS }).then((r) => r.json());
        const hint = { remoteUrl: snap.remoteUrl, name: snap.name, pathName: snap.pathName };
        for (const patch of snap.patches || []) {
          const result = acceptPeerPatch(patch, hint, { skipIfOrigin: true });
          if (result.applied) pulled.push(patch.file);
        }
      } catch {
        /* guest can relay pull later */
      }

      try {
        await pullRoomHistory(room, project);
      } catch {
        /* history arrives on the next poll */
      }
      pushRoomHistory(room, project).catch(() => undefined);
      publishGraph(project);
      sse.emit("projects", { projects: loadRegistry().projects });
      if (room.roomId) dismissByKey(`invite:${room.roomId}`);
      emitNotice({
        type: "joined",
        key: `in:${room.roomId || "room"}`,
        title: `You're in @${room.hostLogin || "host"}'s room`,
        body: room.hostProjectName ? `Sharing ${room.hostProjectName}.` : "Locks and live patches are shared.",
        workspaceId: project.id,
      });

      res.json({ ok: true, room: publicRoom(room), project, seeded, pulled });
    } catch (err) {
      res.status(502).json({ error: "unreachable", detail: String(err.message || err) });
    }
  });
  app.post("/api/room/leave", async (_req, res) => {
    const room = loadRoom();
    if (room?.role === "host") {
      stopTunnelWatch();
      try {
        await publishSignal(
          { ...room, live: false },
          {
            repoKey: room.repoKey || repoKeyFromRemote(currentProject()?.remoteUrl),
            hostLogin: currentUser().login,
          }
        );
      } catch {
        /* leaving still clears locally */
      }
    }
    if (room?.role === "guest" && room.url) {
      // Tell the host before tearing down, so the roster flips this member to
      // offline immediately instead of after the 45s presence timeout.
      await fetchHost(room.url, "/api/room/bye", {
        method: "POST",
        body: JSON.stringify({ login: currentUser().login, hostProjectId: room.hostProjectId }),
      }).catch(() => undefined);
    }
    // saveRoom() stamps room.json into every workspace it touches, so clearing
    // only the selected one leaves other workspaces still pointed at a room the
    // user just left.
    clearRoom(currentProject()?.path);
    for (const p of loadRegistry().projects) {
      clearRoom(p.path);
      // A peer's chats are only meaningful while the room lasts; leaving them
      // behind makes a solo workspace look like it still has collaborators.
      clearPeers(p.id);
    }
    lastPushedSync.clear();
    roomLocks.start(null);
    if (hostRetryTimer) {
      clearTimeout(hostRetryTimer);
      hostRetryTimer = null;
    }
    if (hostSocket) {
      try {
        hostSocket.close();
      } catch {
        /* ignore */
      }
      hostSocket = null;
    }
    res.json({ ok: true, room: null });
  });

  app.get("/api/snapshot", requireRoomMember, (req, res) => {
    const project = req.query.projectId
      ? loadRegistry().projects.find((p) => p.id === req.query.projectId) || currentProject()
      : req.query.path
        ? projectForPath(req.query.path)
        : currentProject();
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const session = loadSession();
    // A joining guest needs the whole tree, not just what git calls dirty:
    // the dirty-only payload leaves anyone without a prior clone staring at an
    // empty folder.
    if (req.query.full === "1" || req.query.full === "true") {
      const { files, truncated } = treeFiles(project.path);
      return res.json({
        ok: true,
        full: true,
        remoteUrl: project.remoteUrl,
        name: project.name,
        pathName: path.basename(project.path),
        workspacePath: project.path,
        files,
        truncated,
      });
    }
    const patches = dirtyFiles(project.path)
      .map((file) =>
        computePatch({
          workspacePath: project.path,
          file,
          agent: "snapshot",
          ownerLogin: session.login || "local",
          workspaceId: project.id,
        })
      )
      .filter(Boolean)
      .map((patch) => {
        patch.originId = originId();
        patch.originAgentId = originId();
        return patch;
      });
    res.json({
      ok: true,
      remoteUrl: project.remoteUrl,
      name: project.name,
      pathName: path.basename(project.path),
      patches,
    });
  });

  app.post("/api/ask", async (req, res) => {
    const project = req.body?.workspacePath ? projectForPath(req.body.workspacePath) : currentProject();
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const limit = Math.min(80, Math.max(5, Number(req.body?.limit) || 30));
    const writeFile = req.body?.write !== false;
    const room = loadRoom(project.path);
    try {
      await syncTranscriptsQueued(project, { ownerLogin: currentUser().login || "local" });
    } catch {
      /* transcripts are best-effort */
    }
    if (room?.role === "guest" && room.url) {
      await pullRoomHistory(room, project).catch(() => undefined);
    }
    const memory = loadMemory(project.id);
    const view = mergeRoomViews(memory);
    const user = currentUser();
    const brief = compileRoomAsk({
      view,
      room,
      login: user.login,
      locks: locksFor({ id: project.id, path: project.path }),
      limit,
    });
    let written = null;
    if (writeFile) {
      const out = path.join(project.path, ".relay", "relay_ask.md");
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, brief.markdown);
        written = out;
      } catch (err) {
        return res.status(500).json({ error: "write_failed", detail: String(err.message || err) });
      }
    }
    res.json({ ok: true, written, markdown: brief.markdown, data: brief.json });
  });

  app.post("/api/push", (req, res) => {
    const project = req.body?.workspacePath ? projectForPath(req.body.workspacePath) : currentProject();
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const files = dirtyFiles(project.path);
    const flushed = files.map((file) => fanOutLocalFile(project, file, originId()));
    res.json({
      ok: true,
      files: flushed.filter((r) => r.flushed).map((r) => r.file),
      skipped: flushed.filter((r) => !r.flushed).length,
    });
  });

  app.post("/api/pull", async (req, res) => {
    const project = req.body?.workspacePath ? projectForPath(req.body.workspacePath) : currentProject();
    const room = loadRoom(project?.path);
    if (!room?.url) return res.status(400).json({ error: "not_in_a_room", hint: "Join a shared room first" });
    if (room.role === "host") {
      return res.json({ ok: true, files: [], note: "host already has the working tree" });
    }
    try {
      const snap = await fetch(`${room.url.replace(/\/$/, "")}/api/snapshot`).then((r) => r.json());
      const hint = { remoteUrl: snap.remoteUrl, name: snap.name, pathName: snap.pathName };
      const applied = [];
      for (const patch of snap.patches || []) {
        const result = acceptPeerPatch(patch, hint, { skipIfOrigin: true });
        if (result.applied) applied.push(patch.file);
      }
      res.json({ ok: true, files: applied });
    } catch (err) {
      res.status(502).json({ error: "unreachable", detail: String(err.message || err) });
    }
  });

  app.post("/api/patches", requireRoomMember, (req, res) => {
    const patch = req.body?.patch;
    if (!patch) return res.status(400).json({ error: "patch_required" });
    const hint = {
      remoteUrl: req.body.remoteUrl,
      name: req.body.name,
      pathName: req.body.pathName,
    };
    const result = acceptPeerPatch(patch, hint, { skipIfOrigin: true });
    broadcastPatch({
      workspaceId: result.projectId || req.body.workspaceId,
      patch,
      incoming: true,
      remoteUrl: hint.remoteUrl,
      name: hint.name,
      pathName: hint.pathName,
      originId: patch.originId,
    });
    res.json({ ok: true, relayed: true, ...result });
  });

  app.get("/api/projects/:id/patches", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const memory = loadMemory(project.id);
    res.json({ patches: memory.patches || [], lastAppliedLamport: memory.lastAppliedLamport || 0 });
  });

  app.post("/api/projects/:id/rewind", (req, res) => {
    const project = loadRegistry().projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    const lamport = Number(req.body?.lamport || 0);
    applyingRemote.add(project.id);
    const result = rewindTo(project.id, project.path, lamport);
    applyingRemote.delete(project.id);
    sse.emit("rewind", { workspaceId: project.id, lamport, count: result.patches.length });
    res.json({ ok: true, ...result });
  });

  app.post("/api/flush-file", (req, res) => {
    const workspacePath = req.body?.workspacePath;
    const agentId = req.body?.agentId;
    const files = Array.isArray(req.body?.files) && req.body.files.length
      ? req.body.files
      : req.body?.file
        ? [req.body.file]
        : [];
    const project = projectForPath(workspacePath);
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const flushed = files.map((file) => fanOutLocalFile(project, file, agentId));
    res.json({ ok: true, flushed });
  });

  app.post("/api/flush-owned", (req, res) => {
    const workspacePath = req.body?.workspacePath;
    const agentId = req.body?.agentId;
    const project = projectForPath(workspacePath);
    if (!project) return res.status(404).json({ error: "no_local_repo" });
    const { sameOwner } = require("./coordinator/lockTable");
    const held = lockTable.list({ id: project.id, path: project.path }).filter((e) => sameOwner(e.agentId, agentId));
    const flushed = held.map((e) => fanOutLocalFile(project, e.filePath, agentId));
    res.json({ ok: true, flushed });
  });

  app.post("/api/claim", (req, res) => {
    const result = lockTable.claim(req.body || {});
    res.status(result.allowed ? 200 : 409).json(result);
  });

  app.post("/api/release", (req, res) => {
    res.json(lockTable.release(req.body || {}));
  });

  app.post("/api/release-all", (req, res) => {
    res.json(lockTable.releaseAll(req.body?.agentId));
  });

  app.post("/api/central/projects", requireCentral, (req, res) => {
    if (!req.central.admin) return res.status(403).json({ error: "admin_only" });
    res.status(201).json(createProject(req.body?.name));
  });

  app.get("/api/central/projects", requireCentral, (req, res) => {
    if (!req.central.admin) return res.status(403).json({ error: "admin_only" });
    res.json({ projects: loadProjects() });
  });

  app.get("/api/central/projects/:id", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    const project = loadProjects().find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "not_found" });
    res.json({ project });
  });

  app.post("/api/central/projects/:id/events", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    const stored = await appendEvent(req.params.id, req.body || {});
    sse.emit("central", { workspaceId: req.params.id, event: stored });
    res.json(stored);
  });

  app.get("/api/central/projects/:id/events", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    const events = await listEvents(req.params.id, {
      since: req.query.since,
      limit: req.query.limit,
      kind: req.query.kind,
    });
    res.json({ events });
  });

  app.get("/api/central/projects/:id/context", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    const events = await listEvents(req.params.id, { limit: 1000 });
    res.json(jsonContext(events));
  });

  app.get("/api/central/projects/:id/changes", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    const events = await listEvents(req.params.id, { kind: "change", limit: 200 });
    res.json({ changes: events });
  });

  app.get("/api/central/projects/:id/decisions", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    res.json({ decisions: jsonContext(await listEvents(req.params.id, { limit: 1000 })).decisions });
  });

  app.get("/api/central/projects/:id/tasks", requireCentral, async (req, res) => {
    if (!req.central.admin && req.central.project?.id !== req.params.id) {
      return res.status(403).json({ error: "project_mismatch" });
    }
    res.json({ tasks: jsonContext(await listEvents(req.params.id, { limit: 1000 })).tasks });
  });

  const uiDist = path.join(__dirname, "..", "mission-control", "out");
  if (fs.existsSync(uiDist)) {
    app.use(express.static(uiDist));
    app.get("/", (_req, res) => res.sendFile(path.join(uiDist, "index.html")));
  } else {
    app.get("/", (_req, res) => {
      res.type("html").send(`<!doctype html><html><body style="background:#0b0c0f;color:#e7e7ea;font-family:sans-serif;padding:48px">
        <h1>Relay API</h1>
        <p>Coordinator on 127.0.0.1:${coordPort}. Open Mission Control at <a href="${UI_ORIGIN}" style="color:#f59e0b">${UI_ORIGIN}</a>.</p>
      </body></html>`);
    });
  }

  const existingRoom = loadRoom();
  if (existingRoom?.role === "guest") {
    connectHostPatches(existingRoom);
    connectHostControl(existingRoom);
  }
  if (existingRoom?.url) syncRoomLocks();

  const port = parsePort(process.argv);
  const server = http.createServer(app);
  wss = new WebSocketServer({ server, path: "/ws/patches" });
  wssControl = new WebSocketServer({ server, path: "/ws/control" });

  /**
   * Identity is decided once, at the handshake, and never re-read from a frame.
   *
   * A socket that re-authorized per message would let a member keep talking
   * after being kicked, and would trust whatever login a frame claimed. The
   * returned session is the only thing downstream is allowed to believe about
   * who is on the other end.
   */
  function authorizeRoomSocket(socket, req) {
    const room = loadRoom();
    const remote = isRemoteRequest(req);
    if (!remote) return { remote: false, login: null, roomId: room?.roomId || null };
    if (room?.role !== "host" || !room.url) {
      socket.close(4403, "not_hosting");
      return null;
    }
    const url = new URL(req.url, "http://localhost");
    const token = req.headers["x-relay-room-token"] || url.searchParams.get("token");
    const member = authorizeMember(room, token);
    if (!member && !room.open) {
      socket.close(4401, "not_a_member");
      return null;
    }
    return { remote: true, login: member?.login || null, roomId: room.roomId || null };
  }

  /** Still the member the handshake proved, and the room still the same room. */
  function sessionValid(session) {
    if (!session?.remote) return true;
    const room = loadRoom();
    if (room?.role !== "host" || !room.url) return false;
    if (session.roomId && room.roomId && session.roomId !== room.roomId) return false;
    if (room.open) return true;
    return Boolean(session.login) && !revokedLogin(room, session.login);
  }

  function revokedLogin(room, login) {
    const tokens = Array.isArray(room.memberTokens) ? room.memberTokens : [];
    return !tokens.some((t) => normLogin(t.login) === normLogin(login));
  }

  // Only a peer's lock traffic is rewritten onto the host's workspace path. A
  // local agent on the host machine is already using that path, and forcing the
  // rewrite on it would file edits made in some other repo against the shared
  // one.
  function peerScoped(body, session) {
    if (!session?.remote) return body;
    const room = loadRoom();
    if (!room?.url || room.role !== "host") return body;
    const shared = loadRegistry().projects.find((p) => p.id === room.hostProjectId) || currentProject();
    if (!shared?.path) return body;
    return { ...body, workspaceId: shared.path, peerWorkspacePath: body?.workspaceId || null };
  }

  const LOCK_OPS = new Set(["claim", "release", "heartbeat", "release-all", "read"]);
  const MAX_FILES_PER_CLAIM = 64;

  /**
   * Everything a remote frame is allowed to influence, restated from scratch.
   *
   * A lock request is a security boundary, not a data structure: `agentId` names
   * the holder the whole room arbitrates against, so a member that could send an
   * arbitrary one could release a teammate's locks and edit the file underneath
   * them. Stamping the authenticated login onto the agentId makes that
   * impossible to express.
   */
  function sanitizeLockBody(body, session) {
    const clean = {
      agentId: String(body?.agentId || "").slice(0, 200),
      file: typeof body?.file === "string" ? body.file.slice(0, 1024) : undefined,
      workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId : undefined,
      ttl: Number(body?.ttl) || undefined,
      mode: body?.mode === "read" ? "read" : "write",
      files: Array.isArray(body?.files)
        ? body.files.filter((f) => typeof f === "string").slice(0, MAX_FILES_PER_CLAIM)
        : undefined,
      dependsOn: Array.isArray(body?.dependsOn)
        ? body.dependsOn.filter((f) => typeof f === "string").slice(0, MAX_FILES_PER_CLAIM)
        : undefined,
      holder: body?.holder && typeof body.holder === "object" ? body.holder : null,
    };
    if (!clean.agentId) return null;
    if (session?.remote) {
      const login = session.login || "guest";
      clean.agentId = `${clean.agentId}@${login}`;
      clean.holder = { ...(clean.holder || {}), login };
    }
    return clean;
  }

  function runLockRpc(op, body, session) {
    if (!LOCK_OPS.has(op)) return { error: "unknown_op" };
    const clean = sanitizeLockBody(body, session);
    if (!clean) return { error: "agent_required" };
    const scoped = peerScoped(clean, session);
    if (op === "claim") {
      const result = lockTable.claim(scoped);
      if (!result.allowed) {
        const project = projectForPath(scoped.workspaceId) || currentProject();
        if (project?.id) {
          bumpCollision(project.id, "claim_blocked", {
            file: scoped.file,
            agentId: scoped.agentId,
            holder: result.holder,
            reason: result.reason,
            via: "room_rpc",
          });
        }
      }
      return result;
    }
    if (op === "release") return lockTable.release(scoped);
    if (op === "heartbeat") return lockTable.heartbeat(scoped);
    if (op === "read") {
      const files = (Array.isArray(scoped.files) && scoped.files.length ? scoped.files : [scoped.file]).filter(Boolean);
      for (const file of files) {
        lockTable.noteRead({
          agentId: scoped.agentId,
          filePath: file,
          workspaceId: scoped.workspaceId,
          holder: scoped.holder,
        });
      }
      return { ok: true, files };
    }
    return lockTable.releaseAll(scoped.agentId, scoped.workspaceId);
  }
  // ws re-emits the underlying http server's 'error' on this instance. Without a
  // listener here, EventEmitter rethrows it as an uncaught exception — which
  // preempts the EADDRINUSE handler on `server` below and dumps a raw stack
  // trace instead of the "port already in use" message.
  wss.on("error", (err) => {
    if (err.code === "EADDRINUSE") return; // handled on `server`
    console.warn(`[relay-ws] ${err.message || err}`);
  });
  wss.on("connection", (socket, req) => {
    const session = authorizeRoomSocket(socket, req);
    if (!session) return;
    const room = loadRoom();
    // Greet a joining guest with the current table. Without this a board stays
    // blank from connect until the host's next lock change, which on a quiet
    // repo can be a very long time.
    if (room?.role === "host" && room.url) {
      const project = currentProject();
      if (project) {
        setImmediate(() => sendSocket(socket, roomStatePayload(project, "hello")));
      }
    }
    const beat = setInterval(() => {
      if (socket.readyState !== 1) return;
      try {
        socket.ping();
        socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        /* closed */
      }
    }, 15000);
    if (beat.unref) beat.unref();
    socket.on("close", () => clearInterval(beat));
    socket.on("message", (raw) => {
      try {
        if (!sessionValid(session)) {
          socket.close(4401, "membership_revoked");
          return;
        }
        const msg = JSON.parse(String(raw));
        if (msg.type === "pong" || msg.type === "ping") {
          if (msg.type === "ping") sendSocket(socket, { type: "pong" });
          return;
        }
        if (msg.type === "join") {
          const project = currentProject();
          if (project && loadRoom()?.role === "host") sendSocket(socket, roomStatePayload(project, "hello"));
          return;
        }
        if (msg.type === "history") {
          const project = msg.projectId
            ? loadRegistry().projects.find((p) => p.id === msg.projectId) || currentProject()
            : currentProject();
          // A member may only publish its own history. Trusting the login in the
          // frame would let any member overwrite another's transcript bucket.
          const login = session.remote ? session.login : String(msg.login || "").trim();
          if (!login) return;
          ingestPeerHistory(login, msg.snapshot, project);
          return;
        }
        if (msg.type === "patch" && msg.patch) {
          acceptPeerPatch(msg.patch, {
            remoteUrl: msg.remoteUrl,
            name: msg.name,
            pathName: msg.pathName,
          }, { skipIfOrigin: true });
          broadcastPatch({
            workspaceId: msg.workspaceId,
            patch: msg.patch,
            incoming: true,
            remoteUrl: msg.remoteUrl,
            name: msg.name,
            pathName: msg.pathName,
            originId: msg.patch.originId,
          });
        }
      } catch {
        /* ignore malformed */
      }
    });
  });
  wssControl.on("error", (err) => {
    if (err.code === "EADDRINUSE") return;
    console.warn(`[relay-ws-control] ${err.message || err}`);
  });
  wssControl.on("connection", (socket, req) => {
    const session = authorizeRoomSocket(socket, req);
    if (!session) return;
    const room = loadRoom();
    if (room?.role === "host" && room.url) {
      const shared = lockScope(room.hostProjectId) || (currentProject() ? { id: currentProject().id, path: currentProject().path } : null);
      if (shared) sendSocket(socket, { type: "locks", workspaceId: room.hostProjectId || shared.id, locks: locksFor(shared), reads: readsFor(shared) });
    }
    const beat = setInterval(() => {
      if (socket.readyState !== 1) return;
      try {
        socket.ping();
        sendSocket(socket, { type: "ping" });
      } catch {
        /* closed */
      }
    }, 12000);
    if (beat.unref) beat.unref();
    socket.on("close", () => clearInterval(beat));
    // A lock frame is small by construction. Anything larger is not a claim, and
    // parsing it would only hand an unauthenticated peer a cheap way to burn the
    // host's event loop — the one thing every other agent's claim waits on.
    const MAX_FRAME_BYTES = 64 * 1024;
    const RPC_BURST = 60;
    let windowStart = Date.now();
    let inWindow = 0;
    socket.on("message", (raw) => {
      try {
        if (raw.length > MAX_FRAME_BYTES) {
          socket.close(4413, "frame_too_large");
          return;
        }
        if (!sessionValid(session)) {
          socket.close(4401, "membership_revoked");
          return;
        }
        const msg = JSON.parse(String(raw));
        if (msg.type === "pong" || msg.type === "ping") {
          if (msg.type === "ping") sendSocket(socket, { type: "pong" });
          return;
        }
        if (msg.type === "join") {
          const hosted = loadRoom();
          const shared = lockScope(hosted?.hostProjectId) || (currentProject() ? { id: currentProject().id, path: currentProject().path } : null);
          if (shared) sendSocket(socket, { type: "locks", workspaceId: hosted.hostProjectId || shared.id, locks: locksFor(shared), reads: readsFor(shared) });
          return;
        }
        if (msg.type !== "rpc") return;
        const now = Date.now();
        if (now - windowStart > 1000) {
          windowStart = now;
          inWindow = 0;
        }
        if (++inWindow > RPC_BURST) {
          sendSocket(socket, { type: "rpc-err", id: msg.id, error: "rate_limited" });
          return;
        }
        try {
          sendSocket(socket, { type: "rpc-ok", id: msg.id, result: runLockRpc(msg.op, msg.body, session) });
        } catch (err) {
          sendSocket(socket, { type: "rpc-err", id: msg.id, error: err.message || "rpc_failed" });
        }
      } catch {
        /* ignore */
      }
    });
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[relay-api] port ${port} is already in use — another \`relay serve\` is running. ` +
          `Leaving its coordinator state untouched.`
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    writeState(process.cwd(), coordPort, { apiPort: port });
    console.log(`[relay-api] http://127.0.0.1:${port}`);
    console.log(`[relay-coordinator] 127.0.0.1:${coordPort}`);
    console.log(`[relay-ui] ${UI_ORIGIN}`);
    const hosted = loadRoom();
    if (hosted?.role === "host") {
      startTunnelWatch();
      shareRoom(port, shareExtras(currentProject()))
        .then(async (result) => {
          if (!result.ok) {
            console.warn(`[relay-room] could not resume hosting: ${result.hint || result.error}`);
            return;
          }
          const warning = await publishAndWatch(result.room, currentProject());
          console.log(`[relay-room] resumed hosting at ${result.room.url}`);
          if (warning) console.warn(`[relay-room] ${warning}`);
        })
        .catch((err) => console.warn(`[relay-room] resume failed: ${err.message || err}`));
    } else if (hosted?.role === "guest") {
      refreshGuestRoom(hosted)
        .then((next) => {
          connectHostPatches(next || hosted);
          connectHostControl(next || hosted);
        })
        .catch(() => {
          connectHostPatches(hosted);
          connectHostControl(hosted);
        });
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
