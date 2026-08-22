const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { isBinary, sha256 } = require("./patches");

// Mirrors dirtyFiles' SKIP list. `.relay` is deliberately excluded: it holds the
// host's room.json and lock files, and shipping those to a guest would point the
// guest's coordinator at the guest's own tunnel.
const SKIP_DIR = /^(\.git|\.relay|node_modules|\.next|dist|out|build|\.turbo|\.venv|__pycache__|target)$/i;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4000;

function gitTracked(workspacePath) {
  try {
    const out = execFileSync("git", ["-C", workspacePath, "ls-files", "-co", "--exclude-standard"], {
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

function walk(workspacePath, rel = "", out = [], depth = 0) {
  if (depth > 12 || out.length >= MAX_FILES) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(workspacePath, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (SKIP_DIR.test(entry.name)) continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(workspacePath, next, out, depth + 1);
    else if (entry.isFile()) out.push(next);
  }
  return out;
}

function skipped(rel) {
  return rel.split("/").some((segment) => SKIP_DIR.test(segment));
}

/**
 * Every file a joining peer needs to start from the same tree as the host.
 * Text files travel as UTF-8, binaries as base64 — a guest that only received
 * the git-dirty set (what /api/snapshot used to send) starts with an empty
 * folder unless it happened to already have the repo cloned.
 */
function treeFiles(workspacePath) {
  if (!workspacePath || !fs.existsSync(workspacePath)) return { files: [], truncated: false };
  const listed = gitTracked(workspacePath) || walk(workspacePath);
  const files = [];
  let total = 0;
  let truncated = false;
  for (const raw of listed) {
    const rel = raw.replace(/\\/g, "/");
    if (!rel || skipped(rel)) continue;
    if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const abs = path.join(workspacePath, rel);
    let buf;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      buf = fs.readFileSync(abs);
    } catch {
      continue;
    }
    total += buf.length;
    const binary = isBinary(buf);
    files.push({
      path: rel,
      binary,
      sha256: sha256(buf),
      content: binary ? buf.toString("base64") : buf.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
    });
  }
  return { files, truncated };
}

/** Materializes a treeFiles() payload into a workspace. Returns what landed. */
function writeTree(workspacePath, files) {
  if (!workspacePath || !Array.isArray(files)) return { written: [], failed: [] };
  const written = [];
  const failed = [];
  for (const file of files) {
    const rel = String(file?.path || "").replace(/\\/g, "/");
    // A peer is not allowed to escape the workspace root — `../` in a path from
    // an untrusted room would otherwise write anywhere on this machine.
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..") || /^[a-zA-Z]:/.test(rel)) {
      failed.push(rel || "(empty)");
      continue;
    }
    const abs = path.join(workspacePath, rel);
    const buf = Buffer.from(String(file.content ?? ""), file.encoding === "base64" ? "base64" : "utf8");
    try {
      // Same reason as applyPatchToDisk: an identical rewrite still wakes the
      // watcher, and a whole-tree seed would wake it once per file.
      if (fs.existsSync(abs) && sha256(fs.readFileSync(abs)) === sha256(buf)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      written.push(rel);
    } catch {
      failed.push(rel);
    }
  }
  return { written, failed };
}

module.exports = { treeFiles, writeTree, MAX_FILES, MAX_FILE_BYTES };
