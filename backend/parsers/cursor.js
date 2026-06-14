const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeTs, makeUnifiedDiff, isRedactedContent } = require('../lib/timeline');
const { scanHistoryForWorkspace, getCursorHistoryRoots } = require('../lib/vscodeHistory');

const SOURCE = 'Cursor';
const EDIT_TOOLS = new Set(['Write', 'StrReplace', 'ApplyPatch', 'EditNotebook', 'search_replace']);

const HOME = os.homedir();

function workspaceToCursorSlug(workspacePath) {
  const norm = String(workspacePath || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');

  const driveMatch = norm.match(/^([a-zA-Z]):\/?(.*)$/);
  if (driveMatch) {
    const tail = driveMatch[2].replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return `${driveMatch[1].toLowerCase()}-${tail}`;
  }

  let slug = norm.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (slug.charAt(1) === '-') slug = slug.charAt(0).toLowerCase() + slug.slice(1);
  return slug;
}

function discoverCursorTranscriptDir(workspacePath) {
  const projectsRoot = path.join(HOME, '.cursor', 'projects');
  const slug = workspaceToCursorSlug(workspacePath);
  const direct = path.join(projectsRoot, slug, 'agent-transcripts');
  if (fs.existsSync(direct)) return direct;

  if (!fs.existsSync(projectsRoot)) return null;

  const target = workspacePath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsRoot, entry.name, 'agent-transcripts');
    if (!fs.existsSync(candidate)) continue;

    for (const file of listCursorTranscriptFiles(candidate).slice(0, 3)) {
      try {
        const sample = fs.readFileSync(file, 'utf-8').slice(0, 8000).toLowerCase();
        if (sample.includes(target)) return candidate;
      } catch (_) { }
    }
  }

  return null;
}

function listCursorTranscriptFiles(transcriptDir) {
  if (!transcriptDir || !fs.existsSync(transcriptDir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(transcriptDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const jsonl = path.join(transcriptDir, entry.name, `${entry.name}.jsonl`);
      if (fs.existsSync(jsonl)) files.push(jsonl);
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(path.join(transcriptDir, entry.name));
    }
  }

  return files.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
}

function extractUserText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => {
      const match = part.text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      return match ? match[1].trim() : part.text.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text.trim())
    .filter(Boolean)
    .join('\n');
}

function toolToCodeEdit(tool, ts) {
  const name = tool.name;
  if (!EDIT_TOOLS.has(name)) return null;

  const input = tool.input || {};
  const filePath = input.path || input.file_path || input.target_notebook || null;
  if (!filePath) return null;

  let diff = null;
  let summary = `${name} ${path.basename(filePath)}`;

  if (name === 'StrReplace' && input.old_string != null && input.new_string != null) {
    diff = makeUnifiedDiff(input.old_string, input.new_string, path.basename(filePath));
    summary = `Edited ${path.basename(filePath)}`;
  } else if (name === 'Write' && input.contents != null) {
    diff = makeUnifiedDiff('', input.contents, path.basename(filePath));
    summary = `Wrote ${path.basename(filePath)}`;
  }

  return {
    ts,
    kind: 'code_edit',
    role: 'assistant',
    source: SOURCE,
    file: path.basename(filePath),
    path: filePath,
    action: name.toLowerCase(),
    summary,
    diff,
  };
}

function parseCursorTranscriptFile(transcriptPath, baseTs) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];
  const fileMtime = fs.statSync(transcriptPath).mtimeMs;
  const startTs = baseTs || normalizeTs(fileMtime);

  lines.forEach((line, index) => {
    try {
      const step = JSON.parse(line);
      const ts = startTs
        ? normalizeTs(Date.parse(startTs) + index * 1000)
        : normalizeTs(fileMtime + index * 1000);

      if (step.role === 'user') {
        const text = extractUserText(step.message?.content);
        if (text && !isRedactedContent(text)) {
          events.push({
            ts,
            kind: 'message',
            role: 'user',
            content: text,
            source: SOURCE,
            transcriptPath,
            lineIndex: index,
          });
        }
      } else if (step.role === 'assistant') {
        const text = extractAssistantText(step.message?.content);
        if (text && !isRedactedContent(text)) {
          events.push({
            ts,
            kind: 'message',
            role: 'assistant',
            content: text,
            source: SOURCE,
            transcriptPath,
            lineIndex: index,
          });
        }

        const tools = Array.isArray(step.message?.content)
          ? step.message.content.filter(part => part?.type === 'tool_use')
          : [];

        for (const tool of tools) {
          const edit = toolToCodeEdit(tool, ts);
          if (edit) events.push(edit);
        }
      }
    } catch (_) { }
  });

  return events;
}

function parseCursor(inputPath, options = {}) {
  const workspacePath = options.workspacePath;
  let transcriptFiles = [];

  if (inputPath && fs.existsSync(inputPath)) {
    if (fs.statSync(inputPath).isDirectory()) {
      transcriptFiles = listCursorTranscriptFiles(inputPath);
    } else {
      transcriptFiles = [inputPath];
    }
  } else if (workspacePath) {
    const dir = discoverCursorTranscriptDir(workspacePath);
    if (dir) transcriptFiles = listCursorTranscriptFiles(dir);
  }

  const events = [];
  for (const file of transcriptFiles) {
    events.push(...parseCursorTranscriptFile(file));
  }

  if (workspacePath) {
    events.push(...scanHistoryForWorkspace(workspacePath, {
      roots: getCursorHistoryRoots(),
    }));
  }

  events.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return { events, transcriptFiles };
}

module.exports = {
  parseCursor,
  discoverCursorTranscriptDir,
  listCursorTranscriptFiles,
  workspaceToCursorSlug,
};
