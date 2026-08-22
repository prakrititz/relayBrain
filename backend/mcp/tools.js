/**
 * The MCP tool surface, with no transport attached.
 *
 * `backend/mcp/server.js` feeds this over stdio (one process per agent, started
 * by the agent itself); `POST /mcp` on the room host feeds it over HTTP. Both
 * hand in a context object instead of reading process.env here, so the same
 * thirteen tools can answer for "the agent running on this machine" and for
 * "a room member asking through the tunnel" without either transport growing
 * its own copy of the logic.
 */
const client = require("../coordinator/client");
const { loadMemory, loadRegistry } = require("../lib/store");
const { loadRoom } = require("../lib/room");
const { mergeRoomViews } = require("../lib/roomSync");
const { detectConflicts } = require("../lib/conflicts");
const { appendEvent, listEvents, jsonContext } = require("../lib/centralStore");
const { clientEventId } = require("../lib/memorySync");
const { dependsOn } = require("../lib/deps");
const { syncTranscriptsQueued } = require("../lib/transcripts/sync");

const PROTOCOL_VERSION = "2024-11-05";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// A read that has to cross the tunnel is answering a question the caller could
// also answer from its own last sync. Wait briefly, then do exactly that.
const HOST_TIMEOUT_MS = 1500;

const TOOLS = [
  { name: "relay_get_chat_history", description: "Query unified agent chat history (time-ordered, filterable by agent and owner). In a room this spans every member, not just this machine.", inputSchema: { type: "object", properties: { agent: { type: "string" }, ownerLogin: { type: "string" }, limit: { type: "number" } } } },
  { name: "relay_sync", description: "Re-read agent transcripts into unified memory.json history", inputSchema: { type: "object", properties: {} } },
  { name: "relay_claim_file", description: "Acquire exclusive write lock before editing", inputSchema: { type: "object", properties: { file: { type: "string" }, ttl_ms: { type: "number" } }, required: ["file"] } },
  { name: "relay_release_file", description: "Release a lock after editing", inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
  { name: "relay_status", description: "View full lock table", inputSchema: { type: "object", properties: {} } },
  { name: "relay_report_change", description: "Push a code-change event to Central (JSON, not markdown)", inputSchema: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } } } },
  { name: "relay_get_project_context", description: "Pull Central JSON context (changes, decisions, tasks, agents)", inputSchema: { type: "object", properties: {} } },
  { name: "relay_get_recent_changes", description: "Recent code_edit events from memory.json + Central", inputSchema: { type: "object", properties: {} } },
  { name: "relay_get_decisions", description: "Decision events from Central JSONL", inputSchema: { type: "object", properties: {} } },
  { name: "relay_get_active_tasks", description: "Task events from Central JSONL", inputSchema: { type: "object", properties: {} } },
  { name: "relay_report_decision", description: "Append a decision event", inputSchema: { type: "object", properties: { decision_id: { type: "string" }, decision: { type: "string" }, status: { type: "string" } } } },
  { name: "relay_update_task", description: "Append a task event", inputSchema: { type: "object", properties: { task_id: { type: "string" }, description: { type: "string" }, status: { type: "string" } } } },
  { name: "relay_get_conflicts", description: "Overlapping edits in the last 5 minutes", inputSchema: { type: "object", properties: {} } },
];

/**
 * What a caller reached through the tunnel is allowed to do.
 *
 * Everything absent from this set writes somewhere — the lock table, Central,
 * memory.json — and would write it as *this* machine: the host's workspace
 * path, the host's RELAY_USER, an agentId the host cannot verify. A guest
 * already has a local relay for those, on a transport that works when the
 * tunnel does not, so the remote surface stays a read.
 */
const READ_ONLY = new Set([
  "relay_get_chat_history",
  "relay_status",
  "relay_get_project_context",
  "relay_get_recent_changes",
  "relay_get_decisions",
  "relay_get_active_tasks",
  "relay_get_conflicts",
]);

function toolsFor(ctx) {
  return ctx?.readOnly ? TOOLS.filter((t) => READ_ONLY.has(t.name)) : TOOLS;
}

function resolveProjectId(workspace) {
  const reg = loadRegistry();
  return (
    process.env.RELAY_PROJECT_ID ||
    reg.projects.find((p) => p.path === workspace)?.id ||
    reg.projects[0]?.id
  );
}

/** The context a stdio server runs with: this machine, full access. */
function defaultCtx(overrides = {}) {
  const workspace = process.env.RELAY_WORKSPACE_PATH || process.cwd();
  return {
    workspace,
    projectId: resolveProjectId(workspace),
    agentId: process.env.RELAY_AGENT_ID || "mcp:local:stdio",
    user: process.env.RELAY_USER || "local",
    owner: process.env.RELAY_OWNER || "local",
    centralProjectId: process.env.RELAY_CENTRAL_PROJECT_ID || null,
    readOnly: false,
    viewer: null,
    ...overrides,
  };
}

function clampLimit(value) {
  const n = Number(value) || DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

/**
 * The most recent `limit` events, oldest first.
 *
 * memory.history is stored ascending, so the local-only path used to take the
 * tail. mergeRoomViews hands back descending, and taking the tail of *that*
 * would answer a question about right now with the oldest events in the room.
 * Sorting first makes the tool independent of whichever source answered.
 */
function newest(events, limit) {
  return [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-limit);
}

/** The host aggregate, shaped like the peer bucket roomSync already merges. */
function asPeer(body) {
  const owner = body.hostLogin || "host";
  const stamp = (rows) =>
    (Array.isArray(rows) ? rows : []).map((row) => ({ ...row, ownerLogin: row.ownerLogin || owner, mine: false }));
  return {
    login: owner,
    updatedAt: Date.now(),
    lastTranscriptSyncAt: Number(body.lastTranscriptSyncAt) || 0,
    chats: stamp(body.chats),
    timeline: stamp(body.timeline),
    activity: stamp(body.activity),
    edits: stamp(body.edits),
    agents: Array.isArray(body.agents) ? body.agents.map((a) => ({ ...a, ownerLogin: a.ownerLogin || owner })) : [],
    stats: body.stats && typeof body.stats === "object" ? body.stats : {},
  };
}

// An agent that calls three read tools in a row is asking one question, and
// three tunnel round trips would answer it three times. One second is short
// enough that nothing here is ever meaningfully staler than a single request.
const HOST_CACHE_MS = 1000;
let hostCache = null;

async function fetchHostState(room) {
  const base = String(room.url).replace(/\/$/, "");
  if (hostCache && hostCache.base === base && Date.now() - hostCache.at < HOST_CACHE_MS) return hostCache.body;
  const query = room.hostProjectId ? `?projectId=${encodeURIComponent(room.hostProjectId)}` : "";
  const res = await fetch(`${base}/api/room/state${query}`, {
    signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    headers: {
      "ngrok-skip-browser-warning": "relay",
      ...(room.memberToken ? { "x-relay-room-token": room.memberToken } : {}),
    },
  });
  if (!res.ok) throw new Error(`room/state ${res.status}`);
  const body = await res.json();
  if (!body?.ok) throw new Error("room/state not ok");
  hostCache = { base, at: Date.now(), body };
  return body;
}

function peerAgeMs(memory) {
  const peers = Object.values(memory?.roomPeers || {});
  if (!peers.length) return 0;
  const oldest = Math.min(...peers.map((p) => p?.updatedAt || 0));
  return oldest ? Date.now() - oldest : 0;
}

/**
 * What this machine can see of the room, best source first.
 *
 * A host already holds every peer snapshot locally, so it never leaves the
 * process. A guest asks the host — and when the tunnel is down falls back to
 * the snapshots roomSync parked in its own memory.json, which is stale but is
 * the difference between a degraded answer and no answer. Solo, mergeRoomViews
 * returns the local arrays untouched, so this costs nothing and changes
 * nothing for anyone not in a room.
 */
async function roomView(ctx, memory) {
  const room = loadRoom(ctx.workspace);
  if (room?.role === "guest" && room.url) {
    try {
      const peer = asPeer(await fetchHostState(room));
      const merged = mergeRoomViews({ ...memory, roomPeers: { ...(memory.roomPeers || {}), host: peer } });
      return {
        ...merged,
        room: {
          source: "host",
          peers: merged.peerLogins,
          peer_snapshot_age_ms: Math.max(0, Date.now() - (hostCache?.at || Date.now())),
        },
      };
    } catch {
      /* tunnel down or host asleep — answer from the last sync instead */
    }
  }
  const merged = mergeRoomViews(memory);
  return {
    ...merged,
    room: {
      source: merged.peerLogins.length ? "local_snapshot" : "solo",
      peers: merged.peerLogins,
      peer_snapshot_age_ms: peerAgeMs(memory),
    },
  };
}

/** Overrides win, but only where the caller actually supplied one. */
function withCtx(context = {}) {
  const supplied = Object.fromEntries(Object.entries(context).filter(([, v]) => v !== undefined));
  return { ...defaultCtx(), ...supplied };
}

async function callTool(name, args = {}, context = {}) {
  const ctx = withCtx(context);
  if (ctx.readOnly && !READ_ONLY.has(name)) {
    throw new Error(`${name} is not available to remote callers - run it against your own relay.`);
  }
  const pid = ctx.projectId;
  const memory = pid ? loadMemory(pid) : { chats: [], timeline: [], edits: [] };
  const centralId = ctx.centralProjectId || pid;

  switch (name) {
    case "relay_get_chat_history": {
      const limit = clampLimit(args.limit);
      const view = await roomView(ctx, memory);
      const history = (view.history || []).filter(
        (e) => (!args.agent || e.agent === args.agent) && (!args.ownerLogin || e.ownerLogin === args.ownerLogin)
      );
      const chats = (view.chats || []).filter(
        (c) => (!args.agent || c.agent === args.agent) && (!args.ownerLogin || c.ownerLogin === args.ownerLogin)
      );
      return {
        history: newest(history, limit),
        chats: chats.slice(0, limit),
        timeline: (view.timeline || []).slice(0, limit),
        room: view.room,
      };
    }
    case "relay_sync": {
      const reg = loadRegistry();
      const project = reg.projects.find((p) => p.id === pid);
      if (!project) return { ok: false, error: "no_project" };
      const next = await syncTranscriptsQueued(project, { ownerLogin: ctx.owner });
      return { ok: true, events: (next.history || []).length, chats: (next.chats || []).length };
    }
    case "relay_claim_file":
      return client.claimFile(ctx.workspace, ctx.agentId, args.file, args.ttl_ms, {
        dependsOn: dependsOn(ctx.workspace, args.file),
      });
    case "relay_release_file":
      return client.releaseFile(ctx.workspace, ctx.agentId, args.file);
    case "relay_status":
      return client.status(ctx.workspace);
    case "relay_get_recent_changes": {
      const view = await roomView(ctx, memory);
      return { edits: view.edits || [], room: view.room };
    }
    case "relay_get_conflicts": {
      const view = await roomView(ctx, memory);
      return { conflicts: detectConflicts({ ...memory, edits: view.edits || [] }), room: view.room };
    }
    case "relay_report_change":
      return appendEvent(centralId, {
        kind: "change",
        client_event_id: clientEventId(Date.now(), args.file || "", 0),
        user: ctx.user,
        content: args.content,
        file: args.file,
        agent_source: ctx.agentId,
      });
    case "relay_get_project_context": {
      const events = await listEvents(centralId, { limit: 500 });
      return jsonContext(events);
    }
    case "relay_get_decisions":
      return { decisions: jsonContext(await listEvents(centralId, { kind: "decision", limit: 200 })).decisions };
    case "relay_get_active_tasks":
      return { tasks: jsonContext(await listEvents(centralId, { kind: "task", limit: 200 })).tasks };
    case "relay_report_decision":
      return appendEvent(centralId, {
        kind: "decision",
        client_event_id: clientEventId(Date.now(), args.decision_id || "", 0),
        user: ctx.user,
        content: args.decision,
        decision_id: args.decision_id,
        status: args.status || "open",
        agent_source: ctx.agentId,
      });
    case "relay_update_task":
      return appendEvent(centralId, {
        kind: "task",
        client_event_id: clientEventId(Date.now(), args.task_id || "", 0),
        user: ctx.user,
        content: args.description,
        task_id: args.task_id,
        status: args.status || "open",
        agent_source: ctx.agentId,
      });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

/**
 * One JSON-RPC message in, one reply out (or null for a notification, which
 * takes no reply on either transport). Throws on tool failure; the transport
 * decides how to word the error.
 */
async function handleRpc(msg, ctx = {}) {
  const { id, method, params } = msg || {};
  if (method === "initialize") {
    return {
      id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        serverInfo: { name: "relay", version: "0.1.0" },
        capabilities: { tools: {} },
      },
    };
  }
  if (method === "tools/list") return { id, result: { tools: toolsFor(ctx) } };
  if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments || {}, ctx);
    return { id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
  }
  if (id != null) return { id, result: {} };
  return null;
}

module.exports = { TOOLS, READ_ONLY, toolsFor, callTool, handleRpc, defaultCtx, PROTOCOL_VERSION };
