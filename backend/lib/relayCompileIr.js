const fs = require('fs');
const path = require('path');
const { IR_FILES, buildCompileBrief } = require('./relayContext');

const IR_TARGETS = ['project.md', 'current_task.md', 'decisions.md'];

const LLM_SYSTEM = `You maintain Relay IR markdown files for cross-agent project memory.
Merge the timeline into the current IR files. Preserve checked tasks and resolved decisions unless clearly obsolete.
Return ONLY valid JSON (no markdown fences) with keys: project.md, current_task.md, decisions.md
Each value is the full updated markdown file content including # headings.`;

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

function resolveLlmConfig(workspacePath) {
  let config = {};
  try {
    const raw = safeRead(path.join(workspacePath, '.relay', 'config.json'));
    config = raw ? JSON.parse(raw) : {};
  } catch (_) {
    config = {};
  }

  const llm = config.llm || {};
  const provider =
    llm.provider ||
    process.env.RELAY_LLM_PROVIDER ||
    (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');

  const apiKey =
    llm.apiKey ||
    process.env.RELAY_LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    null;

  const model =
    llm.model ||
    process.env.RELAY_LLM_MODEL ||
    (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');

  const baseUrl =
    llm.baseUrl ||
    process.env.RELAY_LLM_BASE_URL ||
    (provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/messages'
      : 'https://api.openai.com/v1/chat/completions');

  const enabled =
    llm.enabled !== false &&
    (llm.enabled === true || Boolean(apiKey) || process.env.RELAY_LLM_AUTO === '1');

  return { enabled, provider, apiKey, model, baseUrl };
}

function parseJsonFromLlm(text) {
  const trimmed = String(text || '').trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM response did not contain JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function callOpenAiCompatible({ baseUrl, apiKey, model, userPrompt }) {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: LLM_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic({ apiKey, model, userPrompt }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      temperature: 0.2,
      system: LLM_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic request failed (${res.status}): ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  const block = data.content?.find(c => c.type === 'text');
  return block?.text || '';
}

async function callLlm(config, userPrompt) {
  if (!config.apiKey) {
    throw new Error('No LLM API key — set OPENAI_API_KEY, ANTHROPIC_API_KEY, or RELAY_LLM_API_KEY');
  }

  if (config.provider === 'anthropic') {
    return callAnthropic({ apiKey: config.apiKey, model: config.model, userPrompt });
  }

  return callOpenAiCompatible({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    userPrompt,
  });
}

function buildLlmUserPrompt(brief) {
  const lines = [
    'Update these IR markdown files from the timeline sample.',
    '',
    '## Current IR files',
  ];

  for (const file of IR_TARGETS) {
    lines.push(`### ${file}`, brief.irSnapshot[file] || '(empty)', '');
  }

  lines.push('## Timeline sample', brief.timelineSample.join('\n\n---\n\n'));
  return lines.join('\n');
}

function compileIrHeuristic(workspacePath, options = {}) {
  const relayDir = path.join(workspacePath, '.relay');
  const brief = options.brief || buildCompileBrief(workspacePath);
  const memoryPath = path.join(relayDir, 'memory.json');
  let memory = null;
  try {
    memory = JSON.parse(safeRead(memoryPath));
  } catch (_) {
    memory = null;
  }

  const timeline = brief.timelineSample || [];
  const userLines = [];
  const decisionLines = [];

  for (const block of timeline) {
    const text = String(block);
    const contentMatch = text.match(/\n([\s\S]*)$/);
    const body = (contentMatch ? contentMatch[1] : text).trim();
    if (!body || body.length < 8) continue;
    if (/\|\s*user\s*\|/i.test(text)) {
      const line = body.split('\n')[0].slice(0, 200);
      if (!userLines.includes(line)) userLines.push(line);
      if (/\?\s*$/.test(line) || /\b(should we|decide|or )\b/i.test(line)) {
        decisionLines.push(`- [ ] ${line}`);
      }
    }
  }

  const existingTasks = safeRead(path.join(relayDir, IR_FILES.currentTask));
  const inProgress = userLines.slice(-5).map(l => `- [ ] ${l}`);
  const currentTaskMd = existingTasks.includes('## In progress')
    ? existingTasks.replace(
        /(## In progress\n)([\s\S]*?)(\n## Next)/,
        (_, head, _body, tail) => `${head}${inProgress.join('\n') || '- [ ] _(synced from timeline)_'}\n${tail}`
      )
    : `# Current Tasks\n\n## In progress\n${inProgress.join('\n') || '- [ ] _(synced from timeline)_'}\n\n## Next\n- [ ]\n`;

  const existingDecisions = safeRead(path.join(relayDir, IR_FILES.decisions));
  const openBlock = decisionLines.length
    ? decisionLines.slice(-8).join('\n')
    : '- [ ] _(none detected — set RELAY_LLM_API_KEY for smarter extraction)_';
  const decisionsMd = existingDecisions.includes('## Open')
    ? existingDecisions.replace(/(## Open\n)([\s\S]*?)(\n## Resolved)/, `$1${openBlock}\n$3`)
    : `# Decisions\n\n## Open\n${openBlock}\n\n## Resolved\n\n`;

  const lastEdit = [...timeline].reverse().find(b => /\|\s*code_edit/i.test(String(b)));
  const projectExisting = safeRead(path.join(relayDir, IR_FILES.project));
  const editHint = lastEdit ? String(lastEdit).split('\n')[0].slice(0, 120) : null;
  const projectMd =
    projectExisting.trim().length > 80
      ? projectExisting
      : `# Project Summary\n\n## Overview\nWorkspace: ${brief.workspace}\n\n## Tech stack\n-\n\n## Goals\n-\n\n_Last activity: ${editHint || brief.lastSync || 'unknown'}_\n`;

  const written = {};
  for (const [file, content] of [
    [IR_FILES.project, projectMd],
    [IR_FILES.currentTask, currentTaskMd],
    [IR_FILES.decisions, decisionsMd],
  ]) {
    fs.writeFileSync(path.join(relayDir, file), content, 'utf-8');
    written[file] = path.join(relayDir, file);
  }

  return {
    method: 'heuristic',
    written,
    message: 'IR updated from timeline heuristics (no LLM). Set OPENAI_API_KEY for full compile.',
  };
}

async function compileIrWithLlm(workspacePath, options = {}) {
  const relayDir = path.join(workspacePath, '.relay');
  const config = resolveLlmConfig(workspacePath);
  const brief = options.brief || buildCompileBrief(workspacePath);

  if (!config.enabled || !config.apiKey) {
    return compileIrHeuristic(workspacePath, { brief });
  }

  const userPrompt = buildLlmUserPrompt(brief);
  const raw = await callLlm(config, userPrompt);
  const parsed = parseJsonFromLlm(raw);

  const written = {};
  for (const file of IR_TARGETS) {
    const content = parsed[file];
    if (typeof content !== 'string' || !content.trim()) continue;
    const outPath = path.join(relayDir, file);
    fs.writeFileSync(outPath, content.trim() + '\n', 'utf-8');
    written[file] = outPath;
  }

  if (!Object.keys(written).length) {
    throw new Error('LLM returned no IR file contents');
  }

  return {
    method: 'llm',
    provider: config.provider,
    model: config.model,
    written,
    files: Object.keys(written),
  };
}

function compileIrSync(workspacePath, options = {}) {
  const config = resolveLlmConfig(workspacePath);
  if (config.enabled && config.apiKey) {
    return compileIrWithLlm(workspacePath, options);
  }
  return Promise.resolve(compileIrHeuristic(workspacePath, options));
}

module.exports = {
  IR_TARGETS,
  resolveLlmConfig,
  compileIrHeuristic,
  compileIrWithLlm,
  compileIrSync,
};
