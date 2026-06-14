const fs = require('fs');
const path = require('path');
const { scaffoldIrFiles } = require('./relayContext');
const { installAgentHooks, buildRelayCommand } = require('./relayHooks');

const RELAY_VERSION = '0.1.0';
const MARKER_BEGIN = 'BEGIN:relay-os';
const MARKER_END = 'END:relay-os';

const RELAY_PSEUDO_COMMANDS = `## Relay pseudo-commands (user chat)

These are **not** built-in slash commands in Cursor, Claude, Copilot, etc. They are a **project convention** — phrases the user types so agents recognize Relay intent. \`relay init\` patches this block into \`CLAUDE.md\`, \`AGENTS.md\`, \`.github/copilot-instructions.md\`, \`.cursorrules\`, and \`.relay/AGENT_BOOTSTRAP.md\`.

When the user sends any of these phrases (with or without a leading \`/\`), treat them as Relay instructions — not casual chat:

| User says | You do |
|-----------|--------|
| \`/relay update\` or \`relay update\` | \`relay sync .\` → \`relay compile .\` → read \`.relay/compile_brief.md\` → update \`.relay/project.md\`, \`current_task.md\`, \`decisions.md\`, \`failures.md\` → \`relay context .\` → confirm "Relay updated." |
| \`/relay context\` or \`relay context\` | Read \`.relay/relay_context.md\` (run \`relay context .\` first if stale). Summarize handoff briefly. |
| \`/relay init\` or \`relay init\` | Run \`npx relay-os init\` in project root if \`.relay/\` missing; else confirm already installed. |

Use \`npx relay-os\` if \`relay\` is not on PATH. Do not ask the user to edit agent config files manually.`;

const AGENT_IR_INSTRUCTIONS = `Before you finish (every turn with substantive work):

1. \`relay sync .\` and \`relay compile .\`
2. Read \`.relay/compile_brief.md\`
3. Update \`.relay/project.md\`, \`current_task.md\`, \`decisions.md\`, \`failures.md\`
4. \`relay context .\`

Cursor + Claude + Codex + Copilot + Antigravity: stop hook runs steps 1–2 automatically, then you do 3–4.`;

const AGENT_HOOK_BODY = `# Relay (auto-installed)

This project uses **Relay** for cross-agent memory. Do not ask the user to configure agent files manually.

**Every session — read first:** \`.relay/AGENT_BOOTSTRAP.md\`

| Phase | Action |
|-------|--------|
| Session start | Read \`.relay/relay_context.md\` (handoff). Never paste raw transcripts. |
| After agent work | **You** update \`.relay/*.md\` from \`compile_brief.md\` (stop hook triggers this) |
| Background sync | \`relay watch .\` keeps \`memory.json\` + \`compile_brief.md\` fresh |
| Not installed? | Run \`npx relay-os init\` in project root |

**Stop hooks:** Cursor, Claude Code, Codex, Copilot CLI, Antigravity — installed by \`relay init\`.

${RELAY_PSEUDO_COMMANDS}

Cursor: \`@relay-sync\` skill at \`.cursor/skills/relay-sync/\`.
`;

const CURSOR_RULE = `---
description: Relay cross-agent memory — read bootstrap every session
alwaysApply: true
---

At session start in this workspace:

1. If \`.relay/AGENT_BOOTSTRAP.md\` is missing, run \`npx relay-os init\` in the project root (do not ask the user to edit CLAUDE.md or copilot-instructions manually).
2. Read \`.relay/AGENT_BOOTSTRAP.md\` and follow it.
3. For handoff context, read \`.relay/relay_context.md\` — not \`memory.json\` or agent JSONL files.
4. **Stop hook:** syncs + writes \`compile_brief.md\`, then **you** update IR markdown and run \`relay context .\` (all agents have hooks via \`relay init\`).

5. Keep \`relay watch .\` running for background sync across agents.

${RELAY_PSEUDO_COMMANDS}

Use the relay-sync skill when the user says relay update, /relay update, relay context, or relay handoff.
`;

function safeRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return '';
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

function upsertHtmlMarkedBlock(content, blockBody) {
  const begin = `<!-- ${MARKER_BEGIN} -->`;
  const end = `<!-- ${MARKER_END} -->`;
  const block = `${begin}\n${blockBody.trim()}\n${end}`;

  if (content.includes(begin) && content.includes(end)) {
    const re = new RegExp(
      `${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    );
    return content.replace(re, block);
  }

  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function writeUpsertMarkdown(filePath, blockBody) {
  const content = safeRead(filePath);
  fs.writeFileSync(filePath, upsertHtmlMarkedBlock(content, blockBody), 'utf-8');
}

function isRelayInstalled(workspacePath) {
  const relayDir = path.join(workspacePath, '.relay');
  return (
    fs.existsSync(path.join(relayDir, 'config.json')) &&
    fs.existsSync(path.join(relayDir, 'install.json'))
  );
}

function writeAgentBootstrap(workspacePath) {
  const relayDir = path.join(workspacePath, '.relay');

  const md = `# Relay Agent Bootstrap

> **Agents:** read this file at the start of every session in this workspace.

---

## 1. Check install

| Check | Path |
|-------|------|
| Relay initialized | \`.relay/config.json\` |
| Auto-install manifest | \`.relay/install.json\` |

**If either is missing → Relay is not installed. Go to section 2.**  
**If both exist → Relay is installed. Go to section 3.**

---

## 2. Self-install (run once — fully automatic)

Execute in the **project root**:

\`\`\`bash
npx relay-os init
\`\`\`

This automatically:

- Creates \`.relay/\` (memory, IR markdown, context)
- Installs Cursor skill + rule
- Patches \`CLAUDE.md\`, \`AGENTS.md\`, \`.github/copilot-instructions.md\`, \`.cursorrules\`
- Writes this bootstrap file and \`RELAY.md\`

**Do not** ask the user to manually edit agent instruction files.

After \`init\` succeeds, re-read this file and continue at section 3.

---

## 3. Installed — session start (handoff)

1. Read \`.relay/relay_context.md\`.
2. Do **not** load \`.relay/memory.json\` or agent JSONL unless explicitly asked.
3. Respect **CURRENT TASKS** and **OPEN DECISIONS**.

\`\`\`bash
npx relay-os context .
\`\`\`

---

## 4. Pseudo-commands (user chat)

Not native slash commands — a **convention** agents learn from patched instruction files (\`CLAUDE.md\`, \`AGENTS.md\`, \`copilot-instructions.md\`, etc.). When the user types **\`/relay update\`**, **\`relay update\`**, or similar — execute immediately (do not treat as small talk):

| User says | Action |
|-----------|--------|
| \`/relay update\` | sync → compile → update IR from \`compile_brief.md\` → \`relay context .\` |
| \`/relay context\` | Read \`.relay/relay_context.md\` (regenerate with \`relay context .\` if needed) |
| \`/relay init\` | Run \`npx relay-os init\` if Relay not installed |

---

## 5. Stop hooks (automatic after each turn)

| Agent | Hook location |
|-------|----------------|
| Cursor | \`.cursor/hooks.json\` |
| Claude Code | \`.claude/settings.json\` |
| Codex | \`.codex/hooks.json\` |
| Copilot CLI | \`.github/hooks/relay-os.json\` |
| Antigravity | \`.agents/hooks.json\` |

**Background sync:** \`relay watch .\` (all agents, no IR write)

Disable hooks: \`.relay/config.json\` → \`"autoAgentUpdate": false\`

---

## 6. Switching agents

Hand the next agent only \`.relay/relay_context.md\`.

---

## 7. Optional UI

\`\`\`bash
npx relay-os serve
\`\`\`

Open http://localhost:3001/

---

_Package: relay-os v${RELAY_VERSION}_
`;

  const bootstrapPath = path.join(relayDir, 'AGENT_BOOTSTRAP.md');
  fs.writeFileSync(bootstrapPath, md, 'utf-8');

  fs.writeFileSync(
    path.join(workspacePath, 'RELAY.md'),
    `# Relay

Cross-agent project memory for this repo.

**Agents: read [\`.relay/AGENT_BOOTSTRAP.md\`](.relay/AGENT_BOOTSTRAP.md) every session.**

**User pseudo-commands:** \`/relay update\` · \`/relay context\` · \`/relay init\`

\`\`\`bash
npx relay-os init
npx relay-os watch .
npx relay-os refresh .
\`\`\`
`,
    'utf-8'
  );

  return { bootstrapPath };
}

function installCursor(workspacePath, packageRoot) {
  const skillSrc = path.join(packageRoot, 'skills', 'relay-sync');
  const skillDest = path.join(workspacePath, '.cursor', 'skills', 'relay-sync');
  if (fs.existsSync(skillSrc)) {
    copyDirRecursive(skillSrc, skillDest);
  }

  ensureDir(path.join(workspacePath, '.cursor', 'rules'));
  fs.writeFileSync(
    path.join(workspacePath, '.cursor', 'rules', 'relay.mdc'),
    CURSOR_RULE,
    'utf-8'
  );

  return { skill: fs.existsSync(skillDest), rule: true };
}

function installAgentInstructionFiles(workspacePath) {
  const touched = [];
  const targets = [
    path.join(workspacePath, 'CLAUDE.md'),
    path.join(workspacePath, 'AGENTS.md'),
    path.join(workspacePath, '.github', 'copilot-instructions.md'),
    path.join(workspacePath, '.cursorrules'),
  ];

  for (const filePath of targets) {
    if (filePath.includes('.github')) ensureDir(path.dirname(filePath));
    writeUpsertMarkdown(filePath, AGENT_HOOK_BODY);
    touched.push(path.relative(workspacePath, filePath));
  }

  const antigravityPath = path.join(workspacePath, '.relay', 'antigravity-instructions.md');
  fs.writeFileSync(antigravityPath, `${AGENT_HOOK_BODY}\n`, 'utf-8');
  touched.push('.relay/antigravity-instructions.md');

  return touched;
}

function writeInstallManifest(workspacePath, details) {
  const manifest = {
    version: RELAY_VERSION,
    installedAt: new Date().toISOString(),
    workspace: workspacePath,
    ...details,
  };
  fs.writeFileSync(
    path.join(workspacePath, '.relay', 'install.json'),
    JSON.stringify(manifest, null, 2)
  );
  return manifest;
}

function installRelayWorkspace(workspacePath, options = {}) {
  const packageRoot = options.packageRoot || path.join(__dirname, '..', '..');
  ensureDir(path.join(workspacePath, '.relay'));
  scaffoldIrFiles(path.join(workspacePath, '.relay'));

  const cursor = installCursor(workspacePath, packageRoot);
  const hooks = installAgentHooks(workspacePath, packageRoot);
  const instructionFiles = installAgentInstructionFiles(workspacePath);
  writeAgentBootstrap(workspacePath);

  const manifest = writeInstallManifest(workspacePath, {
    cursor,
    hooks,
    relayCommand: buildRelayCommand(packageRoot),
    instructionFiles,
    bootstrap: '.relay/AGENT_BOOTSTRAP.md',
    rootPointer: 'RELAY.md',
  });

  return {
    installed: true,
    manifest,
    paths: {
      relayDir: path.join(workspacePath, '.relay'),
      bootstrap: path.join(workspacePath, '.relay', 'AGENT_BOOTSTRAP.md'),
      rootRelay: path.join(workspacePath, 'RELAY.md'),
    },
  };
}

module.exports = {
  RELAY_VERSION,
  isRelayInstalled,
  installRelayWorkspace,
  writeAgentBootstrap,
  installCursor,
  installAgentInstructionFiles,
};
