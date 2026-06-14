const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── ANTIGRAVITY PARSER ───────────────────────────────────────────────────────
// Reads from: ~/.gemini/antigravity-ide/brain/[convId]/.system_generated/logs/transcript.jsonl
function parseAntigravity(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      if (step.type === 'USER_INPUT' && step.content) {
        const match = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        const text = match ? match[1].trim() : step.content;
        events.push({
          ts: step.created_at || new Date().toISOString(),
          role: 'user',
          content: text,
          source: 'Antigravity',
        });
      } else if (step.type === 'PLANNER_RESPONSE' && step.content) {
        events.push({
          ts: step.created_at || new Date().toISOString(),
          role: 'assistant',
          content: step.content,
          source: 'Antigravity',
        });
      }
    } catch (_) {}
  }
  return events;
}

module.exports = { parseAntigravity };
