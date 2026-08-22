#!/usr/bin/env node
const http = require("http");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { LockTable, sameOwner, normalizeFile } = require("./lockTable");
const { coordinatorStatePath, locksDirFor, homeRelayDir } = require("../lib/paths");
const { softBlock } = require("../lib/depGraph");
const { initTreeSitter } = require("../lib/treeSitterImports");
const { ingest: ingestSupergraph, snapshot: superSnapshot } = require("../lib/supergraph");
const { Presence } = require("../lib/presence");

function parseArgs(argv) {
  const args = { port: process.env.RELAY_COORDINATOR_PORT || 0, workspacePath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (!a.startsWith("-")) args.workspacePath = a;
  }
  return args;
}

function createCoordinator({ workspacePath, preferredPort } = {}) {
  const locksDir = workspacePath
    ? locksDirFor(workspacePath)
    : path.join(homeRelayDir(), "locks");
  const lockTable = new LockTable({ locksDir, workspacePath });
  lockTable.loadFromDisk();
  lockTable.startCleanup();
  const presence = new Presence();

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const startedAt = Date.now();

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      port: app.get("port"),
      uptime: (Date.now() - startedAt) / 1000,
      workspacePath: workspacePath || null,
    });
  });

  app.post("/claim", (req, res) => {
    const body = req.body || {};
    const files = Array.isArray(body.files) && body.files.length ? body.files : [body.file];
    const warnings = [];
    for (const file of files.filter(Boolean)) {
      const blocked = softBlock(lockTable, body.workspaceId || workspacePath, body.agentId, file);
      const held = blocked?.file ? lockTable.getLock(blocked.file, body.workspaceId || workspacePath) : null;
      if (blocked && !(held && sameOwner(held.agentId, body.agentId))) {
        warnings.push(blocked.reason || blocked.holder || String(blocked));
      }
    }
    const result = lockTable.claim(body);
    if (warnings.length && result.allowed) result.warning = result.warning || warnings[0];
    res.status(result.allowed ? 200 : 409).json(result);
  });

  app.post("/heartbeat", (req, res) => {
    res.json(lockTable.heartbeat(req.body || {}));
  });

  app.post("/escalate", (req, res) => {
    const locks = req.body?.locks || [];
    const results = locks.map((lock) => lockTable.escalateRegister(lock));
    res.json({ results });
  });

  app.post("/presence", (req, res) => {
    const { workspaceId, userId, action } = req.body || {};
    const out =
      action === "leave"
        ? presence.leave(workspaceId, userId)
        : presence.join(workspaceId, userId);
    if (out.escalated) {
      const snapshot = lockTable.list(workspaceId);
      for (const lock of snapshot) lockTable.escalateRegister(lock);
    }
    res.json(out);
  });

  app.post("/patch", (req, res) => {
    lockTable.emit("patch", req.body || {});
    res.json({ ok: true });
  });

  app.post("/graph", (req, res) => {
    res.json(ingestSupergraph(req.body?.workspaceId, req.body || {}));
  });

  app.get("/graph", (req, res) => {
    res.json(superSnapshot(req.query.workspaceId));
  });

  app.post("/release", (req, res) => {
    res.json(lockTable.release(req.body || {}));
  });

  app.post("/release-all", (req, res) => {
    res.json(lockTable.releaseAll(req.body?.agentId, req.body?.workspaceId));
  });

  app.get("/status", (_req, res) => {
    res.json({ ...lockTable.status(), uptime: (Date.now() - startedAt) / 1000 });
  });

  app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify(lockTable.status())}\n\n`);
    const listener = () => res.write(`data: ${JSON.stringify(lockTable.status())}\n\n`);
    lockTable.on("change", listener);
    req.on("close", () => lockTable.off("change", listener));
  });

  const server = http.createServer(app);
  return { app, server, lockTable, presence, preferredPort: Number(preferredPort) || 0 };
}

function writeState(workspacePath, port, extra = {}) {
  const state = { port, ...extra, startedAt: new Date().toISOString(), pid: process.pid };
  const targets = [coordinatorStatePath(null)];
  if (workspacePath) targets.push(coordinatorStatePath(workspacePath));
  for (const file of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }
}

async function listen(server, preferredPort) {
  const tryPort = async (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListen);
        reject(err);
      };
      const onListen = () => {
        server.off("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(port, "127.0.0.1");
    });

  try {
    return await tryPort(preferredPort || 0);
  } catch (err) {
    if (err.code === "EADDRINUSE") return tryPort(0);
    throw err;
  }
}

async function startStandalone() {
  await initTreeSitter();
  const args = parseArgs(process.argv);
  const { app, server, lockTable } = createCoordinator({
    workspacePath: args.workspacePath,
    preferredPort: args.port,
  });
  const port = await listen(server, Number(args.port) || 0);
  app.set("port", port);
  writeState(args.workspacePath, port);
  console.log(`[relay-coordinator] listening on 127.0.0.1:${port}`);
  return { port, lockTable, server };
}

if (require.main === module) {
  startStandalone().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createCoordinator, listen, writeState, startStandalone };
