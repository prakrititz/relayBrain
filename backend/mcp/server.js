#!/usr/bin/env node
/**
 * MCP stdio — newline JSON-RPC. Chat history + locks. No markdown compile.
 *
 * The tools themselves live in ./tools.js so the room host can serve the same
 * surface over HTTP; this file is only the stdio framing.
 */
const { handleRpc, defaultCtx } = require("./tools");

function sendResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendErr(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    try {
      // Rebuilt per message so a project registered after this process started
      // still resolves, exactly as the inline lookup used to.
      const reply = await handleRpc(msg, defaultCtx());
      if (reply) sendResult(reply.id, reply.result);
    } catch (err) {
      sendErr(msg?.id, err.message);
    }
  }
});
