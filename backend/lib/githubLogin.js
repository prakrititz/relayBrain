const { spawn } = require("child_process");
const { loadRegistry, saveRegistry, saveSession, loadSession } = require("./store");
const { authorizeUrl, exchangeCode } = require("./githubOAuth");

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", () => reject(new Error("GitHub CLI (gh) is not installed")));
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `gh exited ${code}`));
    });
  });
}

function upsertUser(user) {
  const reg = loadRegistry();
  const idx = reg.users.findIndex((u) => u.login === user.login || u.id === user.id);
  if (idx >= 0) reg.users[idx] = { ...reg.users[idx], ...user };
  else reg.users.unshift(user);
  saveRegistry(reg);
  saveSession({ ...loadSession(), userId: user.id, login: user.login });
  return user;
}

async function loginFromGh() {
  const raw = await runGh(["api", "user"]);
  const gh = JSON.parse(raw);
  return upsertUser({
    id: `gh_${gh.id}`,
    login: gh.login,
    name: gh.name || gh.login,
    avatarUrl: gh.avatar_url,
  });
}

async function loginDeviceFlow() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error("no_device_flow");
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: "read:user repo" }),
  });
  const device = await res.json();
  if (!device.device_code) throw new Error(device.error || "device_code_failed");
  return device;
}

async function pollDevice(device) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const started = Date.now();
  const interval = (device.interval || 5) * 1000;
  while (Date.now() - started < (device.expires_in || 900) * 1000) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = await res.json();
    if (body.access_token) {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${body.access_token}`, "User-Agent": "relay-it" },
      });
      const gh = await userRes.json();
      return upsertUser({
        id: `gh_${gh.id}`,
        login: gh.login,
        name: gh.name || gh.login,
        avatarUrl: gh.avatar_url,
      });
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") continue;
    throw new Error(body.error_description || body.error || "device_denied");
  }
  throw new Error("device_expired");
}

function logout() {
  saveSession({ userId: null, login: null, projectId: loadSession().projectId });
}

function whoami() {
  const session = loadSession();
  const user = loadRegistry().users.find((u) => u.id === session.userId || u.login === session.login);
  return { session, user: user || null };
}

module.exports = {
  loginFromGh,
  loginDeviceFlow,
  pollDevice,
  upsertUser,
  logout,
  whoami,
  authorizeUrl,
  exchangeCode,
};
