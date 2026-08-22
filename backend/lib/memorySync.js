const crypto = require("crypto");
const { loadMemory, saveMemory, id } = require("./store");

function appendStopTurn(projectId, { agent, ownerLogin, sessionId, messages, edits }) {
  const memory = loadMemory(projectId);
  const ts = Date.now();
  const mineLogin = ownerLogin;
  const chatId = `chat_${sessionId || id("sess")}`;
  let thread = memory.chats.find((c) => c.id === chatId);
  if (!thread) {
    thread = { id: chatId, agent, ownerLogin, mine: true, messages: [] };
    memory.chats.unshift(thread);
  }
  for (const m of messages || []) thread.messages.push(m);

  const events = (messages || []).map((m) => ({
    type: m.role === "user" ? "user" : m.role === "tool" ? "edit" : "assistant",
    text: m.text,
    file: m.file,
  }));
  memory.timeline.unshift({
    id: id("seg"),
    agent,
    ownerLogin,
    mine: true,
    ts,
    title: `Stop sync · ${agent}`,
    events,
  });

  for (const edit of edits || []) {
    memory.edits.unshift({
      id: id("e"),
      agent,
      ownerLogin,
      mine: true,
      file: edit.file,
      ts,
      diff: edit.diff || "",
    });
    memory.activity.unshift({
      id: id("a"),
      kind: "edit",
      agent,
      ownerLogin,
      mine: true,
      text: `Edited ${edit.file}`,
      ts,
    });
  }

  memory.stats = memory.stats || {};
  memory.stats.events = (memory.stats.events || 0) + 1;
  memory.stats.patches = memory.edits.length;
  saveMemory(projectId, memory);
  return memory;
}

function clientEventId(ts, filepath, index) {
  return crypto.createHash("sha256").update(`${ts}|${filepath}|${index}`).digest("hex");
}

module.exports = { appendStopTurn, clientEventId };
