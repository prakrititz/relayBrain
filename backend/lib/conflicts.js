function normalizePath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase()
    .replace(/\/$/, "");
}

function detectConflicts(memory, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const edits = (memory.edits || []).filter((e) => now - e.ts <= windowMs);
  const byFile = new Map();
  for (const e of edits) {
    const key = normalizePath(e.file);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(e);
  }
  const conflicts = [];
  for (const [file, list] of byFile) {
    const agents = [...new Set(list.map((e) => e.agent))];
    if (agents.length < 2) continue;
    conflicts.push({
      file,
      agents,
      edits: list.map((e) => ({
        agent: e.agent,
        ts: new Date(e.ts).toISOString(),
        summary: e.diff ? e.diff.split("\n").slice(0, 2).join(" ") : e.file,
      })),
    });
  }
  return conflicts;
}

module.exports = { detectConflicts, normalizePath };
