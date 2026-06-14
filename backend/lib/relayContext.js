const fs = require('fs');
const path = require('path');
const { normalizeTs } = require('./timeline');

const IR_FILES = {
  project: 'project.md',
  architecture: 'architecture.md',
  decisions: 'decisions.md',
  currentTask: 'current_task.md',
  failures: 'failures.md',
};

const IR_TEMPLATES = {
  'project.md': `# Project Summary

<!-- Maintained by relay compile (coding agent + relay-sync skill). -->

## Overview

## Tech stack

## Goals

`,
  'current_task.md': `# Current Tasks

<!-- Maintained by relay compile. -->

## In progress
- [ ]

## Next
- [ ]

`,
  'decisions.md': `# Decisions

## Open
- [ ]

## Resolved

`,
  'architecture.md': `# Architecture

## Layout
-

## Boundaries
-

`,
  'failures.md': `# Failures & Anti-patterns

<!-- What failed or what NOT to repeat -->

`,
};

const DEFAULT_LIMITS = {
  maxUserMessages: 6,
  maxAssistantMessages: 4,
  maxCodeEdits: 5,
  maxArtifacts: 3,
  maxTaskLines: 12,
  maxDecisionLines: 10,
  maxContentChars: 320,
  maxSummaryChars: 2000,
  maxProjectChars: 1200,
};

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

function truncate(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function scaffoldIrFiles(relayDir) {
  if (!fs.existsSync(relayDir)) fs.mkdirSync(relayDir, { recursive: true });
  for (const [file, template] of Object.entries(IR_TEMPLATES)) {
    const filePath = path.join(relayDir, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, template, 'utf-8');
    }
  }
}

function loadMemory(workspacePath) {
  const memoryPath = path.join(workspacePath, '.relay', 'memory.json');
  if (!fs.existsSync(memoryPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function loadConfig(workspacePath) {
  const configPath = path.join(workspacePath, '.relay', 'config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function readIrSection(relayDir, fileName, maxChars) {
  const content = safeRead(path.join(relayDir, fileName));
  if (!content.trim()) return null;
  return truncate(content.replace(/^#.*\n+/m, '').trim(), maxChars);
}

function extractOpenDecisions(decisionsMd, maxLines) {
  if (!decisionsMd) return [];

  const lines = decisionsMd.split('\n');
  const open = [];
  let inOpen = false;

  for (const line of lines) {
    if (/^##\s*open/i.test(line)) {
      inOpen = true;
      continue;
    }
    if (/^##\s/.test(line) && inOpen) break;

    if (inOpen && line.trim()) {
      if (/^- \[[ xX]\]/.test(line) || /^- /.test(line)) {
        open.push(line.trim());
      }
    }
  }

  if (!open.length) {
    for (const line of lines) {
      if (/^- \[[ ]\]/.test(line)) open.push(line.trim());
    }
  }

  return open.slice(0, maxLines);
}

function extractTaskLines(currentTaskMd, maxLines) {
  if (!currentTaskMd) return [];
  return currentTaskMd
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- [') || l.startsWith('- '))
    .slice(0, maxLines);
}

function getConnectedAgents(config) {
  if (!config?.agents) return [];
  return Object.entries(config.agents)
    .filter(([, data]) => data?.status === 'connected')
    .map(([name, data]) => ({
      name,
      connectedAt: data.connectedAt || null,
      eventCount: data.eventCount || 0,
      transcriptPath: data.transcriptPath || null,
    }));
}

function getTimeline(memory) {
  if (Array.isArray(memory?.timeline) && memory.timeline.length) {
    return memory.timeline;
  }
  const merged = [];
  for (const [agent, data] of Object.entries(memory?.agents || {})) {
    for (const event of data?.events || []) {
      merged.push({ ...event, source: event.source || agent });
    }
  }
  merged.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return merged;
}

function findLastCheckpoint(timeline) {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === 'checkpoint') return e;
  }
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === 'code_edit') return e;
  }
  return null;
}

function selectRelevantEvents(timeline, limits) {
  const messages = timeline.filter(e => (e.kind || 'message') === 'message');
  const edits = timeline.filter(e => e.kind === 'code_edit');
  const artifacts = timeline.filter(e => e.kind === 'artifact');

  const userMsgs = messages.filter(e => e.role === 'user').slice(-limits.maxUserMessages);
  const assistantMsgs = messages.filter(e => e.role === 'assistant').slice(-limits.maxAssistantMessages);
  const recentEdits = edits.slice(-limits.maxCodeEdits);
  const recentArtifacts = artifacts.slice(-limits.maxArtifacts);

  const picked = [...userMsgs, ...assistantMsgs, ...recentEdits, ...recentArtifacts];
  picked.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));

  return picked.map(event => formatEventForContext(event, limits.maxContentChars));
}

function formatEventForContext(event, maxChars) {
  const kind = event.kind || 'message';
  const base = {
    ts: normalizeTs(event.ts) || event.ts || null,
    source: event.source || null,
    kind,
    role: event.role || null,
  };

  if (kind === 'code_edit' || kind === 'artifact') {
    return {
      ...base,
      file: event.file || null,
      path: event.path || null,
      summary: truncate(event.summary || event.content || 'File edited', maxChars),
      hasDiff: Boolean(event.diff),
    };
  }

  return {
    ...base,
    content: truncate(event.content || '', maxChars),
  };
}

function formatCheckpoint(checkpoint) {
  if (!checkpoint) {
    return { status: 'none', message: 'No checkpoint or code edit recorded yet.' };
  }

  return {
    ts: normalizeTs(checkpoint.ts) || checkpoint.ts,
    source: checkpoint.source,
    kind: checkpoint.kind,
    file: checkpoint.file || checkpoint.path || null,
    summary: checkpoint.summary || checkpoint.content || null,
  };
}

function buildProjectSummary(relayDir, memory, config, limits) {
  const fromIr = readIrSection(relayDir, IR_FILES.project, limits.maxProjectChars);
  if (fromIr && !fromIr.includes('Describe what this project')) {
    return fromIr;
  }

  const workspace = memory?.workspace || config?.workspace || 'unknown';
  const agents = getConnectedAgents(config);
  const timeline = getTimeline(memory);
  const lastSync = memory?.lastSync || 'never';

  return [
    `Workspace: ${workspace}`,
    `Connected agents: ${agents.length ? agents.map(a => a.name).join(', ') : 'none'}`,
    `Timeline events: ${timeline.length}`,
    `Last sync: ${lastSync}`,
    '',
    'Tip: run `relay compile` (relay-sync skill) to populate this from the synced timeline.',
  ].join('\n');
}

const COMPILE_LIMITS = {
  maxTimelineEvents: 60,
  maxEventChars: 600,
};

function formatTimelineEventForCompile(event, maxChars) {
  const kind = event.kind || 'message';
  const header = `[${event.ts || '?'}] ${event.source || '?'} | ${kind}${event.role ? ` | ${event.role}` : ''}`;
  if (kind === 'code_edit' || kind === 'artifact') {
    const body = [event.file || event.path, event.summary || event.content].filter(Boolean).join(' — ');
    return `${header}\n${truncate(body, maxChars)}`;
  }
  return `${header}\n${truncate(event.content || '', maxChars)}`;
}

function buildCompileBrief(workspacePath, options = {}) {
  const limits = { ...COMPILE_LIMITS, ...(options.limits || {}) };
  const relayDir = path.join(workspacePath, '.relay');
  scaffoldIrFiles(relayDir);

  const memory = loadMemory(workspacePath);
  const config = loadConfig(workspacePath);
  const timeline = memory ? getTimeline(memory) : [];
  const recentTimeline = timeline.slice(-limits.maxTimelineEvents);

  const irSnapshot = {};
  for (const file of Object.values(IR_FILES)) {
    irSnapshot[file] = safeRead(path.join(relayDir, file));
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspace: memory?.workspace || config?.workspace || workspacePath,
    lastSync: memory?.lastSync || null,
    timelineEventCount: timeline.length,
    timelineSampleCount: recentTimeline.length,
    connectedAgents: getConnectedAgents(config),
    irSnapshot,
    timelineSample: recentTimeline.map(e =>
      formatTimelineEventForCompile(e, limits.maxEventChars)
    ),
  };
}

function renderCompileBriefMarkdown(brief) {
  const lines = [
    '# RELAY COMPILE BRIEF',
    '',
    `> Generated ${brief.generatedAt} | workspace \`${brief.workspace}\` | ${brief.timelineSampleCount} of ${brief.timelineEventCount} timeline events`,
    '',
    '**Purpose:** Input for the **relay-sync skill** (coding agent). Use this to update IR markdown — not for handoff to a fresh agent (use `relay_context.md` for that).',
    '',
    '---',
    '',
    '## Agent instructions',
    '',
    '1. Read the **Timeline sample** below (from `.relay/memory.json` — not raw agent JSONL).',
    '2. Merge into the **Current IR files** — preserve resolved decisions and checked tasks unless obsolete.',
    '3. Write updated files under `.relay/`:',
    '   - `project.md` — stable overview, stack, goals',
    '   - `current_task.md` — `- [ ]` / `- [x]` under In progress / Next',
    '   - `decisions.md` — open under `## Open`, resolved under `## Resolved`',
    '   - optionally `architecture.md`, `failures.md` if the timeline supports it',
    '4. Run: `npx relay-os context .` to refresh `relay_context.md` for the next agent.',
    '',
    'Do **not** paste this entire brief into chat when handings off — only the resulting IR + `relay_context.md`.',
    '',
    '---',
    '',
    '## Connected agents',
    '',
    brief.connectedAgents.length
      ? brief.connectedAgents.map(a => `- ${a.name} (${a.eventCount} events)`).join('\n')
      : '_None — run relay sync after connecting agents._',
    '',
    '---',
    '',
    '## Current IR files',
    '',
  ];

  for (const [file, content] of Object.entries(brief.irSnapshot)) {
    lines.push(`### ${file}`, '', '```markdown', content.trim() || '(empty)', '```', '');
  }

  lines.push('---', '', '## Timeline sample', '');

  if (!brief.timelineSample.length) {
    lines.push('_Empty — run `npx relay-os sync .` first._');
  } else {
    for (const block of brief.timelineSample) {
      lines.push('```text', block, '```', '');
    }
  }

  return lines.join('\n');
}

function writeCompileBrief(workspacePath, options = {}) {
  const relayDir = path.join(workspacePath, '.relay');
  const brief = buildCompileBrief(workspacePath, options);
  const markdown = renderCompileBriefMarkdown(brief);
  const jsonPath = path.join(relayDir, 'compile_brief.json');
  const mdPath = path.join(relayDir, 'compile_brief.md');

  fs.writeFileSync(jsonPath, JSON.stringify(brief, null, 2));
  fs.writeFileSync(mdPath, markdown, 'utf-8');

  return { brief, markdown, paths: { json: jsonPath, markdown: mdPath } };
}

function compileRelayContext(workspacePath, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  const relayDir = path.join(workspacePath, '.relay');

  scaffoldIrFiles(relayDir);

  const memory = loadMemory(workspacePath);
  const config = loadConfig(workspacePath);
  const timeline = memory ? getTimeline(memory) : [];

  const projectSummary = buildProjectSummary(relayDir, memory, config, limits);
  const currentTaskMd = safeRead(path.join(relayDir, IR_FILES.currentTask));
  const decisionsMd = safeRead(path.join(relayDir, IR_FILES.decisions));

  const context = {
    version: 1,
    generatedAt: new Date().toISOString(),
    workspace: memory?.workspace || config?.workspace || workspacePath,
    lastSync: memory?.lastSync || null,
    sections: {
      PROJECT_SUMMARY: projectSummary,
      CURRENT_TASKS: extractTaskLines(currentTaskMd, limits.maxTaskLines),
      OPEN_DECISIONS: extractOpenDecisions(decisionsMd, limits.maxDecisionLines),
      CONNECTED_AGENTS: getConnectedAgents(config),
      LAST_CHECKPOINT: formatCheckpoint(findLastCheckpoint(timeline)),
      RELEVANT_EVENTS: selectRelevantEvents(timeline, limits),
    },
  };

  const markdown = renderRelayContextMarkdown(context);
  return { context, markdown };
}

function renderRelayContextMarkdown(ctx) {
  const s = ctx.sections;
  const lines = [
    '# RELAY_CONTEXT',
    '',
    `> Auto-generated ${ctx.generatedAt} | workspace \`${ctx.workspace}\` | last sync ${ctx.lastSync || 'never'}`,
    '',
    '**Do not paste raw transcripts.** This file is the handoff bundle for new agent sessions.',
    '',
    '---',
    '',
    '## PROJECT SUMMARY',
    '',
    s.PROJECT_SUMMARY,
    '',
    '## CURRENT TASKS',
    '',
    s.CURRENT_TASKS.length
      ? s.CURRENT_TASKS.map(t => `- ${t.replace(/^- /, '')}`).join('\n')
      : '_No tasks yet — run `relay compile` (relay-sync skill) to populate from timeline._',
    '',
    '## OPEN DECISIONS',
    '',
    s.OPEN_DECISIONS.length
      ? s.OPEN_DECISIONS.join('\n')
      : '_No open decisions — run `relay compile` to extract from timeline._',
    '',
    '## CONNECTED AGENTS',
    '',
    s.CONNECTED_AGENTS.length
      ? s.CONNECTED_AGENTS.map(a =>
        `- **${a.name}** | ${a.eventCount} events | connected ${a.connectedAt || '?'}`
      ).join('\n')
      : '_No agents connected — register workspace in Relay UI and connect agents._',
    '',
    '## LAST CHECKPOINT',
    '',
  ];

  if (s.LAST_CHECKPOINT.status === 'none') {
    lines.push(s.LAST_CHECKPOINT.message);
  } else {
    lines.push(
      `- **${s.LAST_CHECKPOINT.kind}** via ${s.LAST_CHECKPOINT.source} at ${s.LAST_CHECKPOINT.ts}`,
      s.LAST_CHECKPOINT.file ? `- File: \`${s.LAST_CHECKPOINT.file}\`` : '',
      s.LAST_CHECKPOINT.summary ? `- ${truncate(s.LAST_CHECKPOINT.summary, 240)}` : '',
    );
  }

  lines.push('', '## RELEVANT EVENTS', '');

  if (!s.RELEVANT_EVENTS.length) {
    lines.push('_No events yet — sync agents to populate timeline._');
  } else {
    for (const e of s.RELEVANT_EVENTS) {
      const label = e.kind === 'code_edit'
        ? `[edit] ${e.source} edited ${e.file || 'file'}`
        : e.kind === 'artifact'
          ? `[artifact] ${e.source} ${e.file || ''}`
          : `[${e.source}] ${e.role}`;
      lines.push(`### ${label} | ${e.ts || '?'}`);
      lines.push('');
      lines.push(e.content || e.summary || '');
      lines.push('');
    }
  }

  lines.push(
    '---',
    '',
    '_Source: `.relay/memory.json` + IR markdown. Regenerate: `npx relay-os context .` after `relay compile`._',
  );

  return lines.filter(Boolean).join('\n');
}

function writeRelayContext(workspacePath, options = {}) {
  const relayDir = path.join(workspacePath, '.relay');
  const { context, markdown } = compileRelayContext(workspacePath, options);

  fs.writeFileSync(path.join(relayDir, 'relay_context.json'), JSON.stringify(context, null, 2));
  fs.writeFileSync(path.join(relayDir, 'relay_context.md'), markdown, 'utf-8');

  return { context, markdown, paths: {
    json: path.join(relayDir, 'relay_context.json'),
    markdown: path.join(relayDir, 'relay_context.md'),
  }};
}

module.exports = {
  IR_FILES,
  IR_TEMPLATES,
  scaffoldIrFiles,
  compileRelayContext,
  writeRelayContext,
  renderRelayContextMarkdown,
  buildCompileBrief,
  writeCompileBrief,
  renderCompileBriefMarkdown,
};
