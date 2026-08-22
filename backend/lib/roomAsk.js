/**
 * Room brief for the `/relay ask` pseudo-command — what teammates' agents did recently.
 * Agents fetch this via MCP `relay_room_brief`; humans do not run a CLI for it.
 */

function sameLogin(a, b) {
  return Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
}

function clip(text, max = 600) {
  const s = String(text || "").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}\n…` : s;
}

function formatTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "";
  }
}

function peerRows(rows, login) {
  return (rows || []).filter((row) => row && !row.mine && !sameLogin(row.ownerLogin, login));
}

function threadPeerMessages(chats, login, limit) {
  const lines = [];
  for (const thread of chats || []) {
    if (sameLogin(thread.ownerLogin, login)) continue;
    const who = thread.ownerLogin ? `@${thread.ownerLogin}` : thread.agent || "peer";
    const agent = thread.agent ? ` (${thread.agent})` : "";
    for (const msg of (thread.messages || []).slice(-6)) {
      if (!msg?.text || msg.role === "system") continue;
      const stamp = formatTs(msg.ts || thread.updatedAt);
      lines.push({ ts: msg.ts || thread.updatedAt || 0, line: `- **${who}${agent}** ${stamp}: ${clip(msg.text, 500)}` });
    }
  }
  return lines.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);
}

function formatLocks(locks) {
  const live = (locks || []).filter((l) => l && !l.released);
  if (!live.length) return "_No files locked right now._\n";
  return (
    live
      .slice(0, 20)
      .map((l) => {
        const who = l.holder?.login ? `@${l.holder.login}` : l.holder?.label || l.agentId || "?";
        return `- \`${l.filePath}\` — ${who} (${l.mode || "write"})`;
      })
      .join("\n") + "\n"
  );
}

/**
 * @param {object} opts
 * @param {object} opts.view — mergeRoomViews output
 * @param {object|null} opts.room — loadRoom()
 * @param {string} opts.login — current GitHub login
 * @param {Array} opts.locks — live lock rows
 * @param {number} opts.limit — max peer edit/chat lines
 */
function compileRoomAsk({ view, room, login, locks = [], limit = 30 }) {
  const peerEdits = peerRows(view.edits, login)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);
  const peerActivity = peerRows(view.activity, login)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);
  const chatLines = threadPeerMessages(view.chats, login, limit);
  const agents = (view.agents || []).filter((a) => a.status === "connected" && !sameLogin(a.ownerLogin, login));

  const roomLine = room?.url
    ? `Room **${room.role}** · ${room.memberCount || view.peerLogins?.length || 0} member(s) · peers: ${(view.peerLogins || []).join(", ") || "none yet"}`
    : "Not in a shared room — showing local activity only.";

  const sections = [];
  sections.push("# Relay ask — teammate activity\n");
  sections.push(`Generated: ${new Date().toISOString()}`);
  sections.push(`${roomLine}\n`);
  sections.push("> Agents load this via MCP `relay_room_brief` when the user says `/relay ask`.\n");

  sections.push("## Connected agents (other machines)\n");
  if (!agents.length) sections.push("_No other connected agents right now._\n");
  else {
    for (const a of agents.slice(0, 12)) {
      const owner = a.ownerLogin ? `@${a.ownerLogin}` : "";
      sections.push(`- **${a.label || a.id}** ${owner}`.trim());
    }
    sections.push("");
  }

  sections.push("## Recent teammate chat\n");
  if (!chatLines.length) sections.push("_No peer chat synced yet — teammate needs `relay serve` + room join._\n");
  else {
    for (const row of chatLines) sections.push(row.line);
    sections.push("");
  }

  sections.push("## Recent teammate code edits\n");
  if (!peerEdits.length) sections.push("_No peer edits in the room feed yet._\n");
  else {
    for (const e of peerEdits) {
      const who = e.ownerLogin ? `@${e.ownerLogin}` : "peer";
      const agent = e.agent ? ` · ${e.agent}` : "";
      sections.push(`- \`${e.file || "?"}\` — ${who}${agent} · ${formatTs(e.ts)}`);
      if (e.diff) sections.push(`  \`\`\`diff\n${clip(e.diff, 400)}\n  \`\`\``);
    }
    sections.push("");
  }

  sections.push("## Teammate activity (tools)\n");
  if (!peerActivity.length) sections.push("_No peer tool activity._\n");
  else {
    for (const a of peerActivity.slice(0, 15)) {
      const who = a.ownerLogin ? `@${a.ownerLogin}` : "peer";
      sections.push(`- ${who} · ${a.agent || "?"} · ${clip(a.text, 120)} · ${formatTs(a.ts)}`);
    }
    sections.push("");
  }

  sections.push("## Live locks (whole room)\n");
  sections.push(formatLocks(locks));

  sections.push("## File sync note\n");
  sections.push(
    "Chat/activity above sync via the room transcript pipeline. **File contents** land on your disk only when post-tool hooks flush patches (`relay serve` + hooks on each machine). If a file is missing locally, ask the editor to re-save it or run `/api/flush-file` — not `relay push` after a git commit.\n"
  );

  const markdown = sections.join("\n");
  const json = {
    room: room
      ? { role: room.role, url: room.url, peers: view.peerLogins || [], memberCount: room.memberCount }
      : null,
    peerEdits,
    peerActivity: peerActivity.slice(0, 15),
    chatLines: chatLines.map((r) => r.line),
    agents: agents.slice(0, 12),
    locks: (locks || []).filter((l) => !l.released).slice(0, 20),
  };
  return { markdown, json };
}

module.exports = { compileRoomAsk, peerRows, sameLogin };
