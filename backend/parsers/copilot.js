const fs = require('fs');

// ─── GITHUB COPILOT PARSER ────────────────────────────────────────────────────
// Reads from: ~/.copilot/session-state/[sessionId]/events.jsonl
function parseCopilot(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  const extractText = (value) => {
    if (Array.isArray(value)) {
      return value
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            if (part.type === 'text' && typeof part.text === 'string') return part.text;
            if (typeof part.content === 'string') return part.content;
          }
          return '';
        })
        .join(' ')
        .trim();
    }

    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') return value.text.trim();
      if (typeof value.content === 'string') return value.content.trim();
    }

    return String(value || '').trim();
  };

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      if (step.type === 'user.message' && step.data?.content) {
        const text = extractText(step.data.content);
        if (text) {
          events.push({
            ts: step.timestamp,
            role: 'user',
            content: text,
            source: 'GitHub Copilot',
          });
        }
      } else if (step.type === 'assistant.message' && step.data?.content) {
        const text = extractText(step.data.content);
        if (text) {
          events.push({
            ts: step.timestamp,
            role: 'assistant',
            content: text,
            source: 'GitHub Copilot',
          });
        }
      }
    } catch (_) { }
  }

  return events;
}

module.exports = { parseCopilot };
