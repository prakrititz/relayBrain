const fs = require("fs");
const path = require("path");
const {
  HOME,
  cursorSlug,
  claudeSlug,
  findJsonlFiles,
  normalizeCompare,
  readJsonl,
  discoverWorkspaceStorageDir,
  pathNeedle,
  pathsMentionedIn,
  pathsCoverWorkspace,
} = require("./util");

const AGENTS = ["Cursor", "Claude Code", "Codex", "Copilot", "Antigravity"];

function listCursorTranscriptFiles(transcriptDir) {
  if (!transcriptDir || !fs.existsSync(transcriptDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(transcriptDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const jsonl = path.join(transcriptDir, entry.name, `${entry.name}.jsonl`);
      if (fs.existsSync(jsonl)) files.push(jsonl);
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(path.join(transcriptDir, entry.name));
    }
  }
  return files.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

// Only the first bytes of a transcript are ever inspected here, but reading it
// with readFileSync pulled the whole file into memory first — and these files
// reach tens of megabytes. Done for several candidates per workspace, for every
// workspace, on a 3s sweep, that read alone was enough to stall the event loop.
function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// Resolving a workspace to its Cursor transcript directory means scanning every
// project Cursor knows about. The answer changes only when a directory appears,
// so a short cache keeps the sweep off that path entirely.
const CURSOR_DIR_TTL_MS = 30000;
const cursorDirCache = new Map();

function discoverCursorDir(workspacePath) {
  const cached = cursorDirCache.get(workspacePath);
  if (cached && Date.now() - cached.at < CURSOR_DIR_TTL_MS) {
    // A cached directory that has since been removed must not be trusted.
    if (!cached.dir || fs.existsSync(cached.dir)) return cached.dir;
  }
  const dir = findCursorDir(workspacePath);
  cursorDirCache.set(workspacePath, { dir, at: Date.now() });
  return dir;
}

function findCursorDir(workspacePath) {
  const projectsRoot = path.join(HOME, ".cursor", "projects");
  const direct = path.join(projectsRoot, cursorSlug(workspacePath), "agent-transcripts");
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(projectsRoot)) return null;
  const target = normalizeCompare(workspacePath);
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, "agent-transcripts");
    if (!fs.existsSync(candidate)) continue;
    for (const file of listCursorTranscriptFiles(candidate).slice(0, 4)) {
      if (readHead(file, 12000).toLowerCase().includes(target)) return candidate;
    }
  }
  return null;
}

function discoverCursor(workspacePath) {
  const dir = discoverCursorDir(workspacePath);
  if (!dir) return [];
  return listCursorTranscriptFiles(dir);
}

// The `cwd` recorded on a Claude transcript row is the authoritative workspace
// for that session. The directory slug alone is not: it is lossy (every
// non-alphanumeric character collapses to "-"), so sibling paths can land in the
// same folder, and the folder can hold unrelated .jsonl files (e.g. `memory/`).
// Checking cwd keeps one workspace's dashboard from showing another's sessions.
function claudeTranscriptCwd(file) {
  // `cwd` is stamped on the session's opening rows, so the head is enough; the
  // tail of a long session can be tens of megabytes of no interest here.
  const lines = readHead(file, 64000).replace(/^\uFEFF/, "").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.cwd) return String(row.cwd);
  }
  return null;
}

function discoverClaude(workspacePath) {
  const root = path.join(HOME, ".claude", "projects");
  const projectDir = path.join(root, claudeSlug(workspacePath));
  if (!fs.existsSync(projectDir)) return [];
  const target = normalizeCompare(workspacePath);
  let files = [];
  try {
    files = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(projectDir, entry.name));
  } catch {
    return [];
  }
  return files.filter((file) => {
    const cwd = claudeTranscriptCwd(file);
    return !cwd || normalizeCompare(cwd) === target;
  });
}

function discoverCodex(workspacePath) {
  const root = path.join(HOME, ".codex", "sessions");
  if (!fs.existsSync(root)) return [];
  const target = normalizeCompare(workspacePath);
  const files = findJsonlFiles(root);
  const matched = [];
  for (const file of files) {
    try {
      const first = JSON.parse(readHead(file, 32000).split("\n")[0] || "{}");
      if (first.type === "session_meta" && first.payload?.cwd && normalizeCompare(first.payload.cwd) === target) {
        matched.push(file);
      }
    } catch {
      /* skip */
    }
  }
  return matched;
}

function discoverCopilot(workspacePath) {
  const storage = discoverWorkspaceStorageDir(workspacePath, [
    path.join(HOME, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
    path.join(HOME, ".config", "Code", "User", "workspaceStorage"),
  ]);
  if (!storage) return [];
  const sessions = [];
  const chatDir = path.join(storage, "chatSessions");
  if (fs.existsSync(chatDir)) {
    for (const entry of fs.readdirSync(chatDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) sessions.push(path.join(chatDir, entry.name));
    }
  }
  const transcriptsDir = path.join(storage, "GitHub.copilot-chat", "transcripts");
  if (fs.existsSync(transcriptsDir)) {
    for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) sessions.push(path.join(transcriptsDir, entry.name));
    }
  }
  return sessions;
}

// Antigravity keeps one directory per conversation under `brain/<uuid>/`, with
// the chat log at `.system_generated/logs/transcript.jsonl`. There is no
// workspace slug anywhere in the layout, so the only way to tell which
// conversations belong to this repo is to read the paths each transcript talks
// about.
function antigravityRoots() {
  return [
    path.join(HOME, ".gemini", "antigravity-ide", "brain"),
    path.join(HOME, ".antigravity", "brain"),
    path.join(HOME, "AppData", "Roaming", "Antigravity IDE", "brain"),
    path.join(HOME, "Library", "Application Support", "Antigravity IDE", "brain"),
  ].filter((dir) => fs.existsSync(dir));
}

// Scanning every conversation on every dashboard poll would mean re-reading tens
// of megabytes every 8 seconds. The set of paths a transcript mentions can only
// change when the file does, so key the cache on size+mtime.
const MENTION_CACHE_MAX = 400;
const mentionCache = new Map();

function mentionedPaths(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const stamp = `${stat.size}:${stat.mtimeMs}`;
  const hit = mentionCache.get(file);
  if (hit && hit.stamp === stamp) return hit.paths;
  let paths;
  try {
    paths = pathsMentionedIn(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (mentionCache.size >= MENTION_CACHE_MAX) mentionCache.delete(mentionCache.keys().next().value);
  mentionCache.set(file, { stamp, paths });
  return paths;
}

// Walking every conversation directory and stat-sorting the result costs ~100ms.
// The dashboard polls each workspace every 8s and the transcript watcher fires
// on every keystroke Antigravity persists, so without a short cache this alone
// would keep a core busy.
const LISTING_TTL_MS = 3000;
let listingCache = { at: 0, files: [] };

function antigravityTranscripts() {
  if (Date.now() - listingCache.at < LISTING_TTL_MS) return listingCache.files;
  const rows = [];
  for (const root of antigravityRoots()) {
    for (const file of findJsonlFiles(root)) {
      // `transcript_full.jsonl` is the same conversation with tool payloads
      // inlined; parsing both would double every message.
      if (path.basename(file) !== "transcript.jsonl") continue;
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      rows.push({ file, mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  listingCache = { at: Date.now(), files: rows.map((r) => r.file) };
  return listingCache.files;
}

const ANTIGRAVITY_MAX_SESSIONS = 12;

function discoverAntigravity(workspacePath) {
  const needle = pathNeedle(workspacePath);
  if (!needle) return [];
  const matched = [];
  for (const file of antigravityTranscripts()) {
    const paths = mentionedPaths(file);
    if (!paths) continue;
    if (pathsCoverWorkspace(paths, needle)) matched.push(file);
    if (matched.length >= ANTIGRAVITY_MAX_SESSIONS) break;
  }
  return matched;
}

function discoverForAgent(agent, workspacePath) {
  if (agent === "Cursor") return discoverCursor(workspacePath);
  if (agent === "Claude Code") return discoverClaude(workspacePath);
  if (agent === "Codex") return discoverCodex(workspacePath);
  if (agent === "Copilot") return discoverCopilot(workspacePath);
  if (agent === "Antigravity") return discoverAntigravity(workspacePath);
  return [];
}

// A Stop hook's `transcript_path` is a hint about the session that just
// finished, not a filter. Returning only that file — which is what every
// discoverX used to do — meant an agent's other sessions vanished from the
// dashboard the moment one of its sessions ended. Treat the hint as one more
// file to be sure of, on top of everything normal discovery finds.
function discoverAgentFiles(agent, workspacePath, hint = {}) {
  const files = discoverForAgent(agent, workspacePath);
  const hinted = hint.transcript_path;
  if (hinted && !files.some((f) => path.resolve(f) === path.resolve(hinted))) {
    try {
      if (fs.existsSync(hinted)) files.unshift(hinted);
    } catch {
      /* unreadable hint — normal discovery still stands */
    }
  }
  return files;
}

function discoverAll(workspacePath, hint = {}) {
  const found = [];
  for (const agent of AGENTS) {
    const agentHint = hint.agent === agent ? hint : {};
    for (const file of discoverAgentFiles(agent, workspacePath, agentHint)) {
      found.push({ agent, file });
    }
  }
  return found;
}

// Every agent whose transcripts we can find needs a root here, otherwise its
// chats only refresh on the dashboard's slow poll — which is what made
// Antigravity and Copilot look frozen while Cursor and Claude updated live.
function transcriptWatchRoots(workspacePath) {
  const roots = [];
  const cursorDir = discoverCursorDir(workspacePath);
  if (cursorDir) roots.push(cursorDir);
  const claudeDir = path.join(HOME, ".claude", "projects", claudeSlug(workspacePath));
  if (fs.existsSync(claudeDir)) roots.push(claudeDir);
  const codexDir = path.join(HOME, ".codex", "sessions");
  if (fs.existsSync(codexDir)) roots.push(codexDir);
  roots.push(...antigravityRoots());
  const copilotStorage = discoverWorkspaceStorageDir(workspacePath, [
    path.join(HOME, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
    path.join(HOME, ".config", "Code", "User", "workspaceStorage"),
  ]);
  if (copilotStorage) roots.push(copilotStorage);
  return [...new Set(roots)];
}

module.exports = {
  AGENTS,
  discoverAll,
  discoverAgentFiles,
  listCursorTranscriptFiles,
  discoverCursorDir,
  transcriptWatchRoots,
};
