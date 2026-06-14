function normalizeTs(value) {
  if (value == null || value === '') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const str = String(value).trim();
  if (!str) return null;

  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();

  return null;
}

const KIND_ORDER = {
  message: 0,
  code_edit: 1,
  artifact: 2,
  checkpoint: 3,
};

const REDACTED_RE = /\[REDACTED\]/i;

function isRedactedContent(text) {
  if (text == null) return false;
  const s = String(text).trim();
  if (!s) return false;
  if (s === '[REDACTED]') return true;
  if (/^\[REDACTED\]\s*$/.test(s)) return true;
  const stripped = s.replace(/\[REDACTED\]/gi, '').trim();
  if (!stripped && REDACTED_RE.test(s)) return true;
  return false;
}

function shouldSkipEvent(event) {
  if (!event) return true;
  if (event.kind === 'message' && isRedactedContent(event.content)) return true;
  if (event.kind === 'artifact' && isRedactedContent(event.content)) return true;
  return false;
}

function compareEvents(a, b) {
  const ta = Date.parse(a.ts || '') || 0;
  const tb = Date.parse(b.ts || '') || 0;
  if (ta !== tb) return ta - tb;

  const ka = KIND_ORDER[a.kind] ?? 9;
  const kb = KIND_ORDER[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;

  if (a.role === 'user' && b.role !== 'user') return -1;
  if (a.role !== 'user' && b.role === 'user') return 1;

  return String(a.source || '').localeCompare(String(b.source || ''));
}

function buildGlobalTimeline(agentsMemory = {}) {
  const merged = [];

  for (const [agentName, agentData] of Object.entries(agentsMemory || {})) {
    if (!agentData || agentData.status !== 'connected') continue;

    for (const event of agentData.events || []) {
      if (shouldSkipEvent(event)) continue;
      merged.push({
        ...event,
        source: event.source || agentName,
        ts: normalizeTs(event.ts) || event.ts || null,
        kind: event.kind || (event.role ? 'message' : 'message'),
      });
    }
  }

  merged.sort(compareEvents);
  return merged;
}

function makeUnifiedDiff(oldStr, newStr, filePath) {
  const oldLines = String(oldStr ?? '').split('\n');
  const newLines = String(newStr ?? '').split('\n');
  const header = `--- a/${filePath || 'file'}\n+++ b/${filePath || 'file'}`;
  const body = [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map(line => `-${line}`),
    ...newLines.map(line => `+${line}`),
  ];
  return `${header}\n${body.join('\n')}`;
}

module.exports = {
  normalizeTs,
  compareEvents,
  buildGlobalTimeline,
  makeUnifiedDiff,
  isRedactedContent,
  shouldSkipEvent,
  KIND_ORDER,
};
