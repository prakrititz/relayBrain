const { execFileSync } = require("child_process");
const path = require("path");

const SKIP = /(^|\/)(\.git|\.relay|node_modules|\.next|dist|out)(\/|$)/i;

function dirtyFiles(workspacePath) {
  if (!workspacePath) return [];
  let out = "";
  try {
    out = execFileSync("git", ["-C", workspacePath, "status", "--porcelain", "-uall"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return [];
  }
  const files = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).replace(/.* -> /, "").trim().replace(/\\/g, "/");
    if (!raw || SKIP.test(raw)) continue;
    files.push(raw);
  }
  return [...new Set(files)];
}

function resolveRel(workspacePath, file) {
  return path.join(workspacePath, file);
}

module.exports = { dirtyFiles, resolveRel };
