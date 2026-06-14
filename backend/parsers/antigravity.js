const fs = require('fs');
const path = require('path');

// ─── FILE UTILS ─────────────────────────────────────────────────────────────
function getFiles(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(ext))
    .map(f => path.join(dir, f));
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch (_) { return ''; }
}

// ─── ANTIGRAVITY PARSER ───────────────────────────────────────────────────────
// Reads from: ~/.gemini/antigravity-ide/brain/[convId]/.system_generated/logs/transcript.jsonl
function parseAntigravity(transcriptPath) {
  // 1. Parse Transcripts
  const content = safeRead(transcriptPath);
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

  // Determine brain directory
  // transcriptPath: .../brain/[id]/.system_generated/logs/transcript.jsonl
  const brainDir = path.resolve(path.dirname(transcriptPath), '../..');

  // 2. Parse Artifacts (.md files)
  const artifactsDir = path.join(brainDir, 'artifacts');
  const artifacts = getFiles(artifactsDir, '.md').map(f => ({
    name: path.basename(f),
    content: safeRead(f),
    metadata: safeRead(f + '.metadata.json')
  }));

  // 3. Parse Tasks (.log files)
  const tasksDir = path.join(brainDir, '.system_generated', 'tasks');
  const tasks = getFiles(tasksDir, '.log').map(f => {
    const raw = safeRead(f);
    return {
      id: path.basename(f, '.log'),
      preview: raw.length > 500 ? raw.substring(raw.length - 500) : raw
    };
  });

  // 4. Parse Messages (.json files)
  const msgsDir = path.join(brainDir, '.system_generated', 'messages');
  const messages = getFiles(msgsDir, '.json').map(f => {
    try { return JSON.parse(safeRead(f)); }
    catch (_) { return null; }
  }).filter(Boolean);

  return { events, artifacts, tasks, messages };
}

module.exports = { parseAntigravity };
