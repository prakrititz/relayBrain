const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { loadRegistry, saveRegistry, saveMemory, saveSession, loadSession, id } = require("./store");
const { emptyMemory, initials } = require("./seed");
const { installProjectHooks } = require("./installHooks");
const { homeRelayDir } = require("./paths");

function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: cwd || process.cwd(), stdio: "inherit", shell: false, windowsHide: true });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} exited ${code}`));
    });
  });
}

function defaultCloneDir(remoteUrl) {
  const name = String(remoteUrl || "")
    .replace(/\.git$/, "")
    .split(/[/\\]/)
    .filter(Boolean)
    .pop() || "repo";
  return path.join(os.homedir(), "Documents", "GitHub", name);
}

function registerProject({ name, workspacePath, remoteUrl, mode }) {
  const reg = loadRegistry();
  const existing = reg.projects.find((p) => p.path === workspacePath);
  if (existing) return existing;
  const project = {
    id: id("proj"),
    name: name || path.basename(workspacePath || "workspace"),
    initials: initials(name || workspacePath || "WS"),
    color: mode === "clone" ? "#a78bfa" : "#34d399",
    path: workspacePath,
    remoteUrl: remoteUrl || null,
    apiKey: "rl_" + crypto.randomBytes(12).toString("hex"),
    createdAt: Date.now(),
    lastSyncAt: Date.now(),
  };
  fs.mkdirSync(path.join(workspacePath, ".relay"), { recursive: true });
  try {
    installProjectHooks(workspacePath);
  } catch {
    /* hooks are best-effort */
  }
  reg.projects.push(project);
  saveRegistry(reg);
  saveMemory(project.id, emptyMemory());
  const session = loadSession();
  saveSession({ ...session, projectId: project.id });
  return project;
}

async function cloneRepo(remoteUrl, dest) {
  if (!remoteUrl) throw new Error("usage: relay clone <git-url> [directory]");
  const target = path.resolve(dest || defaultCloneDir(remoteUrl));
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await runGit(["clone", remoteUrl, target]);
  } else if (!fs.existsSync(path.join(target, ".git"))) {
    throw new Error(`${target} exists and is not a git repo`);
  }
  const project = registerProject({
    name: path.basename(target),
    workspacePath: target,
    remoteUrl,
    mode: "clone",
  });
  return { project, path: target };
}

function detectRemoteUrl(target) {
  if (!fs.existsSync(path.join(target, ".git"))) return null;
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: target,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

function addLocal(workspacePath, name) {
  const target = path.resolve(workspacePath);
  if (!fs.existsSync(target)) throw new Error(`path not found: ${target}`);
  return registerProject({
    name: name || path.basename(target),
    workspacePath: target,
    // A folder added via "Add local repository" is very often already a git
    // repo with a real GitHub remote (e.g. `test` had `origin` set up
    // manually) — read it instead of always registering remoteUrl: null,
    // otherwise features that key off the repo (like the Team tab's GitHub
    // collaborator list) silently have nothing to work with.
    remoteUrl: detectRemoteUrl(target),
    mode: "local",
  });
}

module.exports = { cloneRepo, addLocal, registerProject, defaultCloneDir, homeRelayDir, detectRemoteUrl };
