const { spawn } = require("child_process");

// In-memory only — a per-repo cache is enough to stop every dashboard poll
// (RelayContext polls on an interval) from re-hitting GitHub's API/gh CLI.
const CACHE_MS = 60_000;
const cache = new Map(); // "owner/repo" -> { at, data }

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", () => reject(new Error("gh_not_installed")));
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `gh exited ${code}`));
    });
  });
}

// Matches both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git)
function parseGithubRepo(remoteUrl) {
  if (!remoteUrl) return null;
  const m = String(remoteUrl).match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function permissionOf(u) {
  if (u.role_name) return u.role_name;
  if (u.permissions?.admin) return "admin";
  if (u.permissions?.push) return "write";
  if (u.permissions?.pull) return "read";
  return null;
}

async function fetchCollaboratorsRaw(owner, repo) {
  try {
    // Requires push access on the repo (via `gh auth login`) — this is the
    // real "who can push here" collaborator list, avatars included.
    const raw = await runGh(["api", `repos/${owner}/${repo}/collaborators`, "--paginate"]);
    const list = JSON.parse(raw);
    return list.map((u) => ({
      id: `gh_${u.id}`,
      login: u.login,
      name: u.login,
      avatarUrl: u.avatar_url,
      permission: permissionOf(u),
      source: "collaborators",
    }));
  } catch {
    // Fallback for when `gh` isn't installed/authed, or the caller lacks push
    // access: public contributor list needs no auth at all. Not the same set
    // as real collaborators (it's activity-based, no pending/read-only
    // invites) but better than an empty panel.
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors`, {
        headers: { "User-Agent": "relay-it" },
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const list = await res.json();
      return list.map((u) => ({
        id: `gh_${u.id}`,
        login: u.login,
        name: u.login,
        avatarUrl: u.avatar_url,
        permission: null,
        source: "contributors-fallback",
      }));
    } catch {
      return [];
    }
  }
}

function fetchCollaborators(remoteUrl) {
  const parsed = parseGithubRepo(remoteUrl);
  if (!parsed) return Promise.resolve([]);
  const key = `${parsed.owner}/${parsed.repo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && hit.data.length) return Promise.resolve(hit.data);
  return fetchCollaboratorsRaw(parsed.owner, parsed.repo).then((data) => {
    const prev = cache.get(key);
    const prevAuth = (prev?.data || []).filter((c) => c.source === "collaborators");
    const nextAuth = (data || []).filter((c) => c.source === "collaborators");
    // Prefer a real collaborator list. A later contributors-fallback (gh
    // flaked, no push access this poll) must not shrink a roster we already had.
    if (nextAuth.length) {
      cache.set(key, { at: Date.now(), data });
      return data;
    }
    if (prevAuth.length) {
      cache.set(key, { at: Date.now(), data: prev.data });
      return prev.data;
    }
    if (data.length) {
      cache.set(key, { at: Date.now(), data });
      return data;
    }
    if (prev?.data?.length) {
      cache.set(key, { at: Date.now(), data: prev.data });
      return prev.data;
    }
    cache.set(key, { at: Date.now(), data: [] });
    return [];
  });
}

function peekCollaborators(remoteUrl) {
  const parsed = parseGithubRepo(remoteUrl);
  if (!parsed) return [];
  return cache.get(`${parsed.owner}/${parsed.repo}`)?.data || [];
}

module.exports = { fetchCollaborators, peekCollaborators, parseGithubRepo };
