const fs = require("fs");
const path = require("path");
const { loadMemory, saveMemory, id } = require("../store");
const { discoverAll, AGENTS } = require("./discover");
const { parseFile } = require("./parse");
const { eventId, normalizeWorkspaceRoot } = require("./util");

const HISTORY_CAP = 2000;
const MESSAGES_PER_THREAD = 300;
const inflight = new Map();

function unifyEvent(raw, agent, ownerLogin) {
  const sessionId = raw.sessionId || "session";
  return {
    id: eventId([agent, ownerLogin, raw.transcriptPath, sessionId, raw.index, raw.role, raw.kind, raw.text]),
    ts: raw.ts,
    tsIso: new Date(raw.ts).toISOString(),
    agent,
    ownerLogin,
    sessionId,
    role: raw.role,
    kind: raw.kind,
    text: raw.text || "",
    file: raw.file || null,
    path: raw.path || null,
    diff: raw.diff || "",
    transcriptPath: raw.transcriptPath || null,
  };
}

function compareEvents(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
  if (a.role === "user" && b.role !== "user") return -1;
  if (a.role !== "user" && b.role === "user") return 1;
  return String(a.agent).localeCompare(String(b.agent));
}

function threadKey(event) {
  return `${event.ownerLogin}::${event.agent}::${event.sessionId}`;
}

// Edits carry the absolute path the agent used. Returns the workspace-relative
// path, or null when the edit landed outside this workspace entirely — an agent
// touching a temp file or a sibling repo is not this workspace's activity, and
// showing it as such is what makes one project's feed look like another's.
function relativeEditPath(event, workspacePath) {
  const abs = event.path || event.file || "";
  if (!abs) return null;
  if (!workspacePath || !path.isAbsolute(abs)) return abs.replace(/\\/g, "/");
  const rel = path.relative(workspacePath, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return null;
  return rel;
}

function buildViews(history, ownerLogin, workspacePath) {
  const threads = new Map();
  const edits = [];
  const activity = [];
  const timeline = [];

  for (const event of history) {
    const editPath = event.kind === "code_edit" ? relativeEditPath(event, workspacePath) : null;
    if (event.kind === "code_edit" && !editPath) continue;
    const key = threadKey(event);
    if (!threads.has(key)) {
      threads.set(key, {
        id: `chat_${event.agent.replace(/\s+/g, "-").toLowerCase()}_${event.sessionId}`.slice(0, 80),
        agent: event.agent,
        ownerLogin: event.ownerLogin,
        mine: event.ownerLogin === ownerLogin,
        sessionId: event.sessionId,
        updatedAt: event.ts,
        messages: [],
      });
    }
    const thread = threads.get(key);
    thread.updatedAt = Math.max(thread.updatedAt, event.ts);
    if (event.kind === "message" || event.kind === "code_edit") {
      thread.messages.push({
        role: event.role,
        text: event.text,
        ts: event.ts,
        kind: event.kind,
        file: event.file || undefined,
      });
    }
    if (event.kind === "code_edit") {
      edits.push({
        id: `e_${event.id}`,
        agent: event.agent,
        ownerLogin: event.ownerLogin,
        mine: event.ownerLogin === ownerLogin,
        file: editPath,
        ts: event.ts,
        diff: event.diff || "",
      });
      activity.push({
        id: `a_${event.id}`,
        kind: "edit",
        agent: event.agent,
        ownerLogin: event.ownerLogin,
        mine: event.ownerLogin === ownerLogin,
        text: event.text || `Edited ${event.file}`,
        ts: event.ts,
      });
    }
  }

  const chats = [...threads.values()]
    .map((thread) => ({
      ...thread,
      messages: thread.messages.slice(-MESSAGES_PER_THREAD),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  for (const thread of chats) {
    timeline.push({
      id: `seg_${thread.id}`,
      agent: thread.agent,
      ownerLogin: thread.ownerLogin,
      mine: thread.mine,
      ts: thread.updatedAt,
      title: `${thread.agent} · ${thread.messages.length} events`,
      events: thread.messages.map((m) => ({
        type: m.kind === "code_edit" ? "edit" : m.role,
        text: m.text,
        file: m.file,
      })),
    });
  }
  timeline.sort((a, b) => b.ts - a.ts);

  edits.sort((a, b) => b.ts - a.ts);
  activity.sort((a, b) => b.ts - a.ts);

  return { chats, timeline, edits: edits.slice(0, 400), activity: activity.slice(0, 80) };
}

function markAgents(memory, history, ownerLogin) {
  const latest = new Map();
  for (const event of history) {
    const prev = latest.get(event.agent);
    if (!prev || event.ts > prev) latest.set(event.agent, event.ts);
  }
  const agents = (memory.agents || []).map((row) => {
    const ts = latest.get(row.label);
    const stamped = ownerLogin && !row.ownerLogin ? { ...row, ownerLogin } : row;
    if (!ts) return stamped;
    return { ...stamped, status: "connected", lastActiveAt: ts };
  });
  for (const label of AGENTS) {
    if (!agents.some((a) => a.label === label && (!a.ownerLogin || a.ownerLogin === ownerLogin)) && latest.has(label)) {
      agents.push({
        id: label.toLowerCase().replace(/\s+/g, "-"),
        label,
        status: "connected",
        lastActiveAt: latest.get(label),
        ownerLogin: ownerLogin || undefined,
      });
    }
  }
  return agents;
}

function syncTranscripts(project, opts = {}) {
  const ownerLogin = opts.ownerLogin || "local";
  const workspacePath = normalizeWorkspaceRoot(project.path) || project.path;
  const found = discoverAll(workspacePath, opts.hint || {});
  const existing = loadMemory(project.id);
  if (!found.length && ((existing.history || []).length || (existing.chats || []).length)) {
    return existing;
  }
  const history = [];
  const seen = new Set();
  // Which agents actually produced readable transcripts this pass. An agent
  // missing from this set was not refreshed — that is very different from
  // "this agent has nothing to say", and the two must not be conflated below.
  const refreshed = new Set();
  let failed = 0;

  for (const { agent, file } of found) {
    let parsed = [];
    try {
      parsed = parseFile(agent, file);
    } catch (err) {
      // Swallowing this silently is how a parser crash turns into an empty
      // Activity/Chats panel with no way to tell that from "nothing happened".
      failed += 1;
      console.warn(`[relay-transcripts] ${agent} parse failed for ${file}: ${err.message || err}`);
      continue;
    }
    refreshed.add(agent);
    for (const raw of parsed) {
      const event = unifyEvent(raw, agent, ownerLogin);
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      history.push(event);
    }
  }

  // Every discovered transcript blew up: keep whatever was ingested before and
  // leave lastTranscriptSyncAt alone so the next poll retries instead of
  // treating the empty result as the current truth.
  if (failed && failed === found.length) {
    console.warn(`[relay-transcripts] ${project.id}: all ${failed} transcript(s) failed to parse — keeping previous history`);
    return existing;
  }

  // History used to be rebuilt from scratch on every pass, so an agent that was
  // momentarily undiscoverable — its session directory not created yet, a
  // rotated transcript, a hint that narrowed discovery to one other agent's
  // file, a parse error — was erased from the dashboard even though nothing had
  // happened to its conversation. That is what made a finished Claude session
  // disappear the moment Cursor's transcript was re-read. Carry forward every
  // event belonging to an agent we did not successfully re-read this pass.
  let carried = 0;
  for (const event of existing.history || []) {
    if (refreshed.has(event.agent)) continue;
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    history.push(event);
    carried += 1;
  }
  if (carried) {
    const kept = [...new Set((existing.history || []).filter((e) => !refreshed.has(e.agent)).map((e) => e.agent))];
    console.log(`[relay-transcripts] ${project.id}: kept ${carried} event(s) from ${kept.join(", ")} (not re-read this pass)`);
  }

  history.sort(compareEvents);
  const capped = history.slice(-HISTORY_CAP);
  const views = buildViews(capped, ownerLogin, workspacePath);
  const memory = existing;
  memory.history = capped;
  memory.chats = views.chats;
  memory.timeline = views.timeline;
  memory.edits = views.edits;
  memory.activity = views.activity;
  memory.agents = markAgents(memory, capped, ownerLogin);
  memory.stats = memory.stats || {};
  memory.stats.events = capped.length;
  memory.stats.patches = views.edits.length;
  memory.stats.agents = new Set(capped.map((e) => e.agent)).size;
  memory.lastTranscriptSyncAt = Date.now();
  if (memory.ir) delete memory.ir;
  saveMemory(project.id, memory);
  return memory;
}

function syncTranscriptsQueued(project, opts = {}) {
  const key = project.id;
  if (inflight.has(key)) return inflight.get(key);
  const pending = Promise.resolve()
    .then(() => syncTranscripts(project, opts))
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

function latestTranscriptMtime(workspacePath) {
  let max = 0;
  for (const { file } of discoverAll(workspacePath)) {
    try {
      max = Math.max(max, fs.statSync(file).mtimeMs);
    } catch {
      /* skip */
    }
  }
  return max;
}

function syncIfStale(project, opts = {}) {
  const workspacePath = normalizeWorkspaceRoot(project.path) || project.path;
  const existing = loadMemory(project.id);
  const mtime = latestTranscriptMtime(workspacePath);
  if (!mtime || mtime <= (existing.lastTranscriptSyncAt || 0)) return Promise.resolve(existing);
  return syncTranscriptsQueued(project, opts);
}

module.exports = {
  syncTranscripts,
  syncTranscriptsQueued,
  syncIfStale,
  latestTranscriptMtime,
  unifyEvent,
  compareEvents,
  id,
};
