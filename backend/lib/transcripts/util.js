const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const HOME = os.homedir();

function normalizeWorkspaceRoot(root) {
  if (!root || typeof root !== "string") return null;
  let trimmed = root.trim();
  if (!trimmed) return null;
  // file:///C:/Users/... and Git Bash /C:/Users or /C:\Users become a real
  // Windows path. path.resolve("/C:/Users") on win32 is C:\C:\Users, which
  // then fails mkdir with ENOENT.
  trimmed = trimmed.replace(/^file:\/+/i, "/");
  const drive = trimmed.match(/^\/?([a-zA-Z]):([\\/].*)$/);
  if (drive) trimmed = `${drive[1]}:${drive[2]}`;
  const doubled = trimmed.match(/^([a-zA-Z]):[\\/]+\1:[\\/]+(.*)$/i);
  if (doubled) trimmed = `${doubled[1]}:\\${doubled[2]}`;
  try {
    return path.resolve(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeCompare(p) {
  return String(p || "")
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
}

// A transcript embeds the same workspace path in three encodings, often within
// one file: JSON-escaped (`c:\\Users\\me`), URL form (`file:///c:/Users/me%20x`),
// and plain. normalizeCompare handles only the last — it turns `\\` into `//`
// and never decodes `%20` — so a substring search for the workspace root misses
// every Antigravity transcript and the agent looks like it has no history at all.
function pathHaystack(text) {
  let s = String(text || "");
  if (s.includes("%")) {
    s = s.replace(/%[0-9a-fA-F]{2}/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
  return s.toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function pathNeedle(p) {
  return pathHaystack(p).replace(/\/+$/, "");
}

const WIN_PATH_RE = /(?:file:\/\/\/)?[a-zA-Z]:(?:\\{1,2}|\/)[^\s"'`,;)\]}<>|*?]*/g;
const POSIX_PATH_RE = /(?:file:\/\/)?\/(?:users|home|workspace|repos|projects|var|opt|srv)\/[^\s"'`,;)\]}<>|*?]*/gi;

// Collects every absolute path the text mentions, normalized. Matching on these
// rather than a raw `includes(root)` keeps `.../relay/test` from claiming the
// transcripts of `.../relay/test-harness`.
function pathsMentionedIn(text) {
  const out = new Set();
  const source = String(text || "");
  for (const re of [WIN_PATH_RE, POSIX_PATH_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) {
      const norm = pathNeedle(match[0].replace(/^file:\/+/i, "/").replace(/^\/([a-zA-Z]:)/, "$1"));
      if (norm.length > 3) out.add(norm);
    }
  }
  return out;
}

function pathsCoverWorkspace(paths, needle) {
  if (!needle) return false;
  for (const candidate of paths) {
    if (candidate === needle || candidate.startsWith(`${needle}/`)) return true;
  }
  return false;
}

function cursorSlug(workspacePath) {
  const norm = String(workspacePath || "")
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
  const driveMatch = norm.match(/^([a-zA-Z]):\/?(.*)$/);
  if (driveMatch) {
    const tail = driveMatch[2]
      .replace(/[^a-zA-Z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `${driveMatch[1].toLowerCase()}-${tail}`;
  }
  let slug = norm.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (slug.charAt(1) === "-") slug = slug.charAt(0).toLowerCase() + slug.slice(1);
  return slug;
}

function claudeSlug(workspacePath) {
  let slug = String(workspacePath || "").replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.charAt(1) === "-") slug = slug.charAt(0).toLowerCase() + slug.slice(1);
  return slug;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function findJsonlFiles(dir, results = [], depth = 0) {
  if (!dir || depth > 8 || !fs.existsSync(dir)) return results;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findJsonlFiles(full, results, depth + 1);
    else if (entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

function mostRecentFile(files) {
  if (!files.length) return null;
  return [...files].sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  })[0];
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}

function toTs(value, fallback = Date.now()) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function eventId(parts) {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 16);
}

function clip(text, max = 8000) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

function isRedacted(text) {
  const s = String(text || "").trim();
  if (!s) return true;
  if (s === "[REDACTED]") return true;
  return !s.replace(/\[REDACTED\]/gi, "").trim() && /\[REDACTED\]/i.test(s);
}

function extractText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        // tool_result / tool_use blocks carry a `content` field holding raw tool
        // output. Reading it as message text makes stdout show up in the chat
        // attributed to whoever sent the enclosing turn.
        if (part?.type === "tool_result" || part?.type === "tool_use") return "";
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return value.content.trim();
  }
  return String(value).trim();
}

function makeUnifiedDiff(oldStr, newStr, filePath) {
  const oldLines = String(oldStr ?? "").split("\n");
  const newLines = String(newStr ?? "").split("\n");
  const name = filePath || "file";
  return [
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n");
}

function discoverWorkspaceStorageDir(workspacePath, roots) {
  const target = normalizeCompare(workspacePath);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspaceJson = path.join(root, entry.name, "workspace.json");
      if (!fs.existsSync(workspaceJson)) continue;
      try {
        const { folder } = JSON.parse(fs.readFileSync(workspaceJson, "utf8"));
        if (!folder || !String(folder).startsWith("file:///")) continue;
        const decoded = decodeURIComponent(String(folder).replace("file:///", "")).replace(/\//g, path.sep);
        if (normalizeCompare(decoded) === target) return path.join(root, entry.name);
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

module.exports = {
  HOME,
  normalizeWorkspaceRoot,
  normalizeCompare,
  pathHaystack,
  pathNeedle,
  pathsMentionedIn,
  pathsCoverWorkspace,
  cursorSlug,
  claudeSlug,
  readJsonl,
  findJsonlFiles,
  mostRecentFile,
  fileMtime,
  toTs,
  eventId,
  clip,
  isRedacted,
  extractText,
  makeUnifiedDiff,
  discoverWorkspaceStorageDir,
};
