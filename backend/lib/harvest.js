const fs = require("fs");
const path = require("path");
const os = require("os");

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeMessages(rows) {
  const messages = [];
  const edits = [];
  for (const row of rows) {
    const role = row.role || row.type || row.message?.role;
    const text =
      row.text ||
      row.content ||
      row.message?.content ||
      (Array.isArray(row.message?.content) ? row.message.content.map((c) => c.text || "").join("\n") : "");
    if (role === "user" || role === "assistant" || role === "human") {
      messages.push({ role: role === "human" ? "user" : role, text: String(text || "").slice(0, 4000) });
    }
    const file =
      row.tool_input?.file_path ||
      row.tool_input?.target_file ||
      row.message?.tool_use?.input?.file_path ||
      null;
    if (file && (role === "tool" || row.type === "tool_use" || row.tool_name)) {
      edits.push({ file: String(file).replace(/\\/g, "/"), diff: "" });
      messages.push({ role: "tool", text: `Edit ${file}`, file });
    }
  }
  return { messages, edits };
}

function findCursorTranscript(sessionId) {
  if (!sessionId) return null;
  const roots = [
    path.join(os.homedir(), ".cursor", "projects"),
    path.join(os.homedir(), ".cursor-tutor"),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    let walked = 0;
    while (stack.length && walked < 400) {
      walked += 1;
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== "node_modules") stack.push(full);
        else if (e.name.includes(sessionId) && e.name.endsWith(".jsonl")) return full;
      }
    }
  }
  return null;
}

function harvest({ transcript_path, sessionId, conversationId }) {
  const file = transcript_path || findCursorTranscript(sessionId || conversationId);
  if (!file) return { messages: [], edits: [], source: null };
  const rows = readJsonl(file);
  const parsed = normalizeMessages(rows);
  parsed.source = file;
  return parsed;
}

module.exports = { harvest, readJsonl, normalizeMessages };
