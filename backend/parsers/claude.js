const fs = require('fs');
const path = require('path');

// ─── CLAUDE CODE PARSER ───────────────────────────────────────────────────────
// Reads from: ~/.claude/projects/[hash]/*.jsonl
function parseClaude(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      if (step.type === 'user' && step.message?.role === 'user') {
        const contentArr = step.message.content;
        const text = Array.isArray(contentArr)
          ? contentArr.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : String(contentArr);
        if (text.trim()) {
          events.push({
            ts: step.timestamp,
            role: 'user',
            content: text,
            source: 'Claude Code',
          });
        }
      } else if (step.type === 'assistant' && step.message?.role === 'assistant') {
        const contentArr = step.message.content;
        const text = Array.isArray(contentArr)
          ? contentArr.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : String(contentArr);
        if (text.trim()) {
          events.push({
            ts: step.timestamp,
            role: 'assistant',
            content: text,
            source: 'Claude Code',
          });
        }
      }
    } catch (_) {}
  }
  return events;
}

module.exports = { parseClaude };
