const fs = require("fs");
const path = require("path");
const { clientEventId } = require("./memorySync");

function configPath(workspacePath) {
  return path.join(workspacePath, ".relay", "central-config.json");
}

function loadConfig(workspacePath) {
  try {
    return JSON.parse(fs.readFileSync(configPath(workspacePath), "utf8"));
  } catch {
    return null;
  }
}

function saveConfig(workspacePath, cfg) {
  fs.mkdirSync(path.dirname(configPath(workspacePath)), { recursive: true });
  fs.writeFileSync(configPath(workspacePath), JSON.stringify(cfg, null, 2));
}

async function pushLocalEdits(workspacePath, projectId, memory) {
  const cfg = loadConfig(workspacePath);
  if (!cfg?.serverUrl || !cfg.apiKey || !cfg.projectId) return { pushed: 0, skipped: true };
  const last = cfg.lastPushedEventTs || 0;
  const edits = (memory.edits || []).filter((e) => e.ts > last);
  let pushed = 0;
  let latest = last;
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const body = {
      kind: "change",
      client_event_id: clientEventId(e.ts, e.file, i),
      user: e.ownerLogin,
      content: e.diff || e.file,
      file: e.file,
      agent_source: e.agent,
      ts: new Date(e.ts).toISOString(),
    };
    const res = await fetch(`${cfg.serverUrl}/api/central/projects/${cfg.projectId}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;
    pushed += 1;
    latest = Math.max(latest, e.ts);
  }
  cfg.lastPushedEventTs = latest;
  saveConfig(workspacePath, cfg);
  return { pushed };
}

async function pullCentralChanges(workspacePath) {
  const cfg = loadConfig(workspacePath);
  if (!cfg?.serverUrl || !cfg.apiKey || !cfg.projectId) return { pulled: 0, skipped: true };
  const since = cfg.lastPulledCentralEventId || 0;
  const res = await fetch(
    `${cfg.serverUrl}/api/central/projects/${cfg.projectId}/events?since=${since}&limit=500`,
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } }
  );
  if (!res.ok) return { pulled: 0, error: res.status };
  const body = await res.json();
  const events = body.events || [];
  if (!events.length) return { pulled: 0 };
  const file = path.join(workspacePath, ".relay", "central_events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let last = since;
  for (const ev of events) {
    fs.appendFileSync(file, JSON.stringify(ev) + "\n");
    if (ev.event_id > last) last = ev.event_id;
  }
  cfg.lastPulledCentralEventId = last;
  saveConfig(workspacePath, cfg);
  const ctx = jsonContextSafe(events);
  fs.writeFileSync(path.join(workspacePath, ".relay", "central_context.json"), JSON.stringify(ctx, null, 2));
  return { pulled: events.length, last };
}

function jsonContextSafe(events) {
  try {
    return require("./centralStore").jsonContext(events);
  } catch {
    return { changes: events.filter((e) => e.kind === "change") };
  }
}

module.exports = { loadConfig, saveConfig, pushLocalEdits, pullCentralChanges };
