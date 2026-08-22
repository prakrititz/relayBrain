const fs = require("fs");
const os = require("os");
const path = require("path");

const projectStates = new Map();
const initPromises = new Map();

function eventsPath(projectId) {
  const dir = path.join(os.homedir(), ".relay-os", "central", "events");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${projectId}.jsonl`);
}

async function _initProjectState(projectId) {
  const file = eventsPath(projectId);
  let lastEventId = 0;
  const clientEventIds = new Set();
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.event_id > lastEventId) lastEventId = ev.event_id;
        if (ev.client_event_id) clientEventIds.add(ev.client_event_id);
      } catch {
        /* skip */
      }
    }
  }
  return { lastEventId, clientEventIds, queue: Promise.resolve() };
}

async function _getProjectState(projectId) {
  if (projectStates.has(projectId)) return projectStates.get(projectId);
  if (!initPromises.has(projectId)) {
    initPromises.set(
      projectId,
      _initProjectState(projectId).then((state) => {
        projectStates.set(projectId, state);
        initPromises.delete(projectId);
        return state;
      })
    );
  }
  return initPromises.get(projectId);
}

async function appendEvent(projectId, event) {
  const state = await _getProjectState(projectId);
  state.queue = state.queue
    .then(async () => {
      if (event.client_event_id && state.clientEventIds.has(event.client_event_id)) {
        return { ...event, ignoredAsDuplicate: true };
      }
      state.lastEventId += 1;
      const stored = {
        ...event,
        event_id: state.lastEventId,
        project_id: projectId,
        ts: event.ts || new Date().toISOString(),
      };
      fs.appendFileSync(eventsPath(projectId), JSON.stringify(stored) + "\n");
      if (stored.client_event_id) state.clientEventIds.add(stored.client_event_id);
      return stored;
    })
    .catch((err) => {
      state.queue = Promise.resolve();
      throw err;
    });
  return state.queue;
}

async function listEvents(projectId, { since = 0, limit = 200, kind } = {}) {
  await _getProjectState(projectId);
  const file = eventsPath(projectId);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.event_id <= Number(since || 0)) continue;
      if (kind && ev.kind !== kind) continue;
      out.push(ev);
      if (out.length >= Number(limit)) break;
    } catch {
      /* skip */
    }
  }
  return out;
}

function jsonContext(events) {
  const changes = events.filter((e) => e.kind === "change").slice(-200).reverse();
  const decisions = {};
  const tasks = {};
  const agents = {};
  for (const e of events) {
    if (e.kind === "decision" && e.decision_id) decisions[e.decision_id] = e;
    if (e.kind === "task" && e.task_id) tasks[e.task_id] = e;
    const key = `${e.user || "unknown"}@${e.agent_source || "agent"}`;
    agents[key] = { key, lastSeen: e.ts };
  }
  return {
    changes,
    decisions: Object.values(decisions),
    tasks: Object.values(tasks),
    agents: Object.values(agents).sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen))),
  };
}

module.exports = { appendEvent, listEvents, jsonContext, eventsPath };
