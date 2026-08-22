#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const root = path.join(__dirname, "..");
const cmd = process.argv[2] || "help";
const rest = process.argv.slice(3);

function help() {
  console.log(`Relay — GitHub Desktop for AI agents

  relay login              Sign in with GitHub (uses gh CLI, or device flow if GITHUB_CLIENT_ID is set)
  relay logout             Clear the local session
  relay whoami             Show the signed-in GitHub user
  relay clone <url> [dir]  git clone + register workspace + install agent hooks
  relay add <path>         Attach an existing local repo
  relay init [path]        Wire hooks, MCP, and relay-os instructions (default: cwd)
  relay serve              Start API on 127.0.0.1:3001 and Mission Control on :3002
  relay serve --no-ui      Start API + coordinator only
  relay push               Send your dirty working-tree files to the shared room
  relay pull               Apply the host's current dirty files onto this clone
  relay status             Health check
  relay mcp-url            Print the MCP config for this room's shared context endpoint
  relay doctor             Why the Coordinator board is empty (run it on the machine that sees nothing)
`);
}

function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function apiPort(args) {
  const idx = args.indexOf("--port");
  if (idx >= 0) return Number(args[idx + 1]);
  return Number(process.env.RELAY_PORT || 3001);
}

async function waitForApi(url, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* still booting */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function serve(args) {
  const noUi = args.includes("--no-ui");
  const forwarded = args.filter((a) => a !== "--no-ui");
  const uiPort = process.env.RELAY_UI_PORT || "3002";
  const port = apiPort(forwarded);
  const apiOrigin = `http://127.0.0.1:${port}`;
  const children = [];

  const api = spawn(process.execPath, [path.join(root, "backend", "server.js"), ...forwarded], {
    stdio: "inherit",
    cwd: root,
    windowsHide: false,
    shell: false,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_UI_ORIGIN: process.env.RELAY_UI_ORIGIN || `http://localhost:${uiPort}`,
    },
  });
  children.push(api);

  let shuttingDown = false;
  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) killTree(child);
    process.exit(code);
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  api.on("exit", (code) => {
    if (!shuttingDown) shutdown(code || 0);
  });

  if (!noUi) {
    const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
    if (!fs.existsSync(nextBin)) {
      console.error("Mission Control is not installed — run npm install");
      shutdown(1);
      return;
    }
    const ready = await waitForApi(`${apiOrigin}/api/health`);
    if (!ready) {
      console.error("[relay] API did not become ready on", apiOrigin);
      shutdown(1);
      return;
    }
    const ui = spawn(process.execPath, [nextBin, "dev", "--port", String(uiPort)], {
      stdio: "inherit",
      cwd: path.join(root, "mission-control"),
      windowsHide: false,
      shell: false,
      env: {
        ...process.env,
        NEXT_PUBLIC_RELAY_API: apiOrigin,
      },
    });
    children.push(ui);
    ui.on("exit", (code) => {
      if (!shuttingDown) shutdown(code || 0);
    });
  }
}

/**
 * Walks the exact chain the Coordinator board depends on and says which link is
 * broken. Locks and the board are different subsystems — a hook claims straight
 * against the host over HTTP, while the board is fed by the lock mirror and SSE
 * — so "locking works but I see nothing" is a normal, and otherwise invisible,
 * way for this to fail.
 */
async function doctor() {
  const api = `http://127.0.0.1:${apiPort(rest)}`;
  const ok = (m) => console.log(`  ok    ${m}`);
  const bad = (m) => console.log(`  BROKE ${m}`);
  const info = (m) => console.log(`        ${m}`);

  console.log("relay doctor — room + Coordinator board\n");
  let hostLockCount = 0;

  let health;
  try {
    health = await fetch(`${api}/api/health`).then((r) => r.json());
    ok(`local API on ${api}`);
  } catch {
    bad(`no local API on ${api} — run \`relay serve\` here`);
    process.exitCode = 1;
    return;
  }

  const room = health.room;
  if (!room?.url) {
    info("no room joined on this machine — the board shows only local agents.");
    info("Host: Team tab -> Invite next to a teammate. Guest: Join on the Team tab.");
    return;
  }
  ok(`room joined as ${room.role} -> ${room.url}`);
  if (room.role === "host") {
    info(`sharing ${room.hostProjectName || "?"} (${room.hostWorkspacePath || "?"})`);
    info("A host reads its own lock table, so the board is local by definition.");
  }

  if (room.role === "guest") {
    if (!room.hostProjectId) {
      bad("room.json has no hostProjectId — the lock mirror never starts, so the");
      info("board stays empty even while your locks work. Re-join with the invite link.");
    } else {
      ok(`mirroring host project ${room.hostProjectId}`);
    }
    const token = require("../backend/lib/room").loadRoom()?.memberToken;
    const hit = async (p) => {
      const r = await fetch(`${String(room.url).replace(/\/$/, "")}${p}`, {
        headers: {
          "ngrok-skip-browser-warning": "relay",
          ...(token ? { "x-relay-room-token": token } : {}),
        },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    };
    try {
      await hit("/api/health");
      ok("host answers through the tunnel");
    } catch (err) {
      bad(`cannot reach the host (${err.message}) — board falls back to local locks`);
      info("Host is unreachable — Relay will look up their current tunnel and reconnect.");
    }
    try {
      const remote = await hit(`/api/locks?projectId=${encodeURIComponent(room.hostProjectId || "")}`);
      hostLockCount = (remote.locks || []).length;
      ok(`host reports ${hostLockCount} lock(s) for the shared project`);
    } catch (err) {
      bad(`host refused /api/locks (${err.message})` + (token ? "" : " — no member token stored"));
    }
  }

  // The mirror polls on its own clock, so a lock claimed a moment ago has not
  // necessarily landed yet. Give it a few beats before calling anything broken.
  let mine = await fetch(`${api}/api/locks`).then((r) => r.json());
  for (let i = 0; i < 8 && hostLockCount > 0 && !(mine.locks || []).length; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    mine = await fetch(`${api}/api/locks`).then((r) => r.json());
  }
  if (hostLockCount > 0 && !(mine.locks || []).length) {
    bad("the host holds locks but this machine mirrors none of them.");
    info("Locks still arbitrate correctly (hooks call the host directly); it is only");
    info("the board that is fed by the mirror. Restart `relay serve` here — and if it");
    info("comes back, report it: the mirror is not committing its polls.");
  }

  const localKeys = new Set(Object.values(mine.raw?.locks || {}).map((l) => `${l.filePath}::${l.agentId}`));
  const fromHost = (mine.locks || []).filter((l) => !localKeys.has(`${l.filePath}::${l.agentId}`));
  console.log("");
  console.log(`  board would render ${(mine.locks || []).length} lock(s):`);
  info(`${fromHost.length} mirrored from the room, ${localKeys.size} claimed on this machine`);
  for (const l of mine.locks || []) {
    info(`${l.filePath}  ${l.holder?.login ? "@" + l.holder.login : l.agentId}  ${l.mode || "write"}`);
  }
  if (!(mine.locks || []).length) {
    console.log("");
    info("Nothing is locked anywhere right now — an empty board here is correct.");
    info("Have someone start an agent edit, then run this again.");
  }
}

async function main() {
  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }
  if (cmd === "doctor") {
    await doctor();
    return;
  }
  if (cmd === "serve") {
    await serve(rest);
    return;
  }
  if (cmd === "push" || cmd === "pull") {
    try {
      const r = await fetch(`http://127.0.0.1:3001/api/${cmd}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await r.json();
      if (!r.ok) {
        console.error(body.hint || body.error || `${cmd} failed`);
        process.exitCode = 1;
        return;
      }
      const files = body.files || [];
      console.log(files.length ? `${cmd} ${files.length} file(s)` : `${cmd}: nothing to ${cmd}`);
      for (const file of files) console.log(`  ${file}`);
    } catch {
      console.error("offline — run relay serve");
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "status") {
    try {
      const r = await fetch("http://127.0.0.1:3001/api/health");
      console.log(JSON.stringify(await r.json(), null, 2));
    } catch {
      console.error("offline — run relay serve");
      process.exitCode = 1;
    }
    return;
  }

  const gh = require("../backend/lib/githubLogin");
  const clone = require("../backend/lib/cloneRepo");

  if (cmd === "whoami") {
    const { user, session } = gh.whoami();
    if (!user) {
      console.log("not signed in — run relay login");
      process.exitCode = 1;
      return;
    }
    console.log(`${user.name} (@${user.login})`);
    if (session.projectId) console.log(`project ${session.projectId}`);
    return;
  }

  if (cmd === "logout") {
    gh.logout();
    console.log("signed out");
    return;
  }

  if (cmd === "login") {
    try {
      const user = await gh.loginFromGh();
      console.log(`signed in as ${user.name} (@${user.login}) via GitHub CLI`);
      return;
    } catch (err) {
      if (process.env.GITHUB_CLIENT_ID) {
        const device = await gh.loginDeviceFlow();
        console.log(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
        const user = await gh.pollDevice(device);
        console.log(`signed in as ${user.name} (@${user.login})`);
        return;
      }
      console.error(err.message || err);
      console.error("Install GitHub CLI and run: gh auth login");
      console.error("Or set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET and use Mission Control → Continue with GitHub.");
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "clone") {
    const url = rest[0];
    const dir = rest[1];
    const { project, path: dest } = await clone.cloneRepo(url, dir);
    console.log(`cloned ${url}`);
    console.log(`workspace ${dest}`);
    console.log(`registered ${project.name} (${project.id})`);
    return;
  }

  if (cmd === "add") {
    const project = clone.addLocal(rest[0], rest[1]);
    console.log(`added ${project.path} as ${project.name}`);
    return;
  }

  if (cmd === "init") {
    const target = path.resolve(rest[0] || process.cwd());
    if (!fs.existsSync(target)) {
      console.error(`path not found: ${target}`);
      process.exitCode = 1;
      return;
    }
    const { installProjectHooks, installGlobalHooks } = require("../backend/lib/installHooks");
    try {
      installProjectHooks(target);
      installGlobalHooks();
      const existing = clone.addLocal(target, path.basename(target));
      console.log(`Relay initialized in ${existing.path}`);
      console.log("Hooks + MCP wired for Cursor, Claude Code, Codex, Copilot CLI, Antigravity.");
      console.log("Run `relay serve`, then say `/relay ask` in any agent — it calls MCP relay_room_brief.");
    } catch (err) {
      console.error(err.message || err);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "mcp-url") {
    const room = require("../backend/lib/room").loadRoom();
    if (!room?.url) {
      console.log("Not in a room. `relay serve`, then Share in Mission Control, or join with an invite link.");
      console.log("Locally your agents already reach relay over stdio — nothing to configure.");
      process.exitCode = 1;
      return;
    }
    const config = {
      mcpServers: {
        "relay-room": {
          type: "http",
          url: `${String(room.url).replace(/\/$/, "")}/mcp`,
          headers: {
            "ngrok-skip-browser-warning": "relay",
            ...(room.memberToken ? { "x-relay-room-token": room.memberToken } : {}),
          },
        },
      },
    };
    console.log(`Room MCP endpoint (${room.role}) — read-only for anyone off this machine.\n`);
    console.log(JSON.stringify(config, null, 2));
    console.log(`\nPaste into the agent's MCP config. It exposes the room's context (chat history,
recent edits, locks, conflicts) to any MCP client — including one on a machine
with no relay installed. Locks and other writes stay on each member's own relay.`);
    if (!room.memberToken && room.role === "guest") {
      console.log("\nNo member token on file — if the host made the room invite-only, re-join with the invite link.");
    }
    return;
  }

  help();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
