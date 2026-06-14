const fs = require('fs');
const path = require('path');

// ─── CODEX PARSER ─────────────────────────────────────────────────────────────
// Reads from: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
function parseCodex(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      if (step.type === 'event_msg') {
        const p = step.payload;
        if (p.type === 'user_message') {
          events.push({
            ts: step.timestamp,
            role: 'user',
            content: (p.message || ''),
            source: 'Codex',
          });
        } else if (p.type === 'agent_message') {
          events.push({
            ts: step.timestamp,
            role: 'assistant',
            content: (p.message || ''),
            source: 'Codex',
          });
        }
      }
    } catch (_) {}
  }
  return events;
}

module.exports = { parseCodex };
