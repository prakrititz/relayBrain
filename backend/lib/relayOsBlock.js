/**
 * Single source of truth for the relay-os agent instruction block.
 * Patched into every agent's instruction surface on `relay add` / `relay init`.
 */

const RELAY_OS_BEGIN = "<!-- BEGIN:relay-os -->";
const RELAY_OS_END = "<!-- END:relay-os -->";

function relayOsBlock() {
  return `${RELAY_OS_BEGIN}
# Relay (auto-installed)

This project uses **Relay** for cross-agent memory. Do not ask the user to configure agent files manually.

**Every session — read first:** \`.relay/AGENT_BOOTSTRAP.md\`

| Phase | Action |
|-------|--------|
| Session start | Read \`.relay/relay_context.md\` (handoff). Never paste raw transcripts. |
| After agent work | **You** update \`.relay/*.md\` from \`compile_brief.md\` (stop hook triggers this) |
| Background sync | \`relay watch .\` keeps \`memory.json\` + \`compile_brief.md\` fresh |
| Not installed? | Run \`relay add .\` or \`relay init\` in project root |

**Stop hooks:** Cursor, Claude Code, Codex, Copilot CLI, Antigravity — installed by \`relay add\` / \`relay init\`.
**Relay MCP:** \`relay_room_brief\`, locks, chat history — installed into each agent's MCP config by \`relay add\`.

## Relay pseudo-commands (user chat)

These are **not** built-in slash commands. They are a **project convention** — phrases the user types so agents recognize Relay intent.

When the user sends any of these phrases (with or without a leading \`/\`), treat them as Relay instructions — not casual chat:

| User says | You do |
|-----------|--------|
| \`/relay update\` or \`relay update\` | \`relay sync .\` → \`relay compile .\` → read \`.relay/compile_brief.md\` → update \`.relay/project.md\`, \`current_task.md\`, \`decisions.md\`, \`failures.md\` → \`relay context .\` → confirm "Relay updated." |
| \`/relay context\` or \`relay context\` | Read \`.relay/relay_context.md\` (run \`relay context .\` first if stale). Summarize handoff briefly. |
| \`/relay ask\` or \`relay ask\` | Call Relay MCP tool **\`relay_room_brief\`** (MCP server **\`relay\`**). Required on **Cursor, Claude Code, Codex, Copilot CLI, and Antigravity** — not a terminal command for the human. Summarize teammate chat, code edits, locks, and file-sync notes. Tell the user before you edit shared files. If \`relay\` MCP is missing, say so and suggest \`relay add .\` + agent restart (do not ask the user to run \`relay ask\`). |
| \`/relay init\` or \`relay init\` | Run \`relay init\` in project root if \`.relay/\` missing; else confirm already installed. |

Use \`npx relay\` if the \`relay\` command is not on PATH. Do not ask the user to edit agent config files manually.

Cursor: \`@relay-sync\` skill at \`.cursor/skills/relay-sync/\`.
${RELAY_OS_END}
`;
}

function agentBootstrap(workspacePath) {
  const ws = workspacePath.replace(/\\/g, "/");
  return `# Relay agent bootstrap

Project: \`${ws}\`

## /relay ask (all agents)

When the user says **\`/relay ask\`** or **\`relay ask\`**:

1. Call MCP tool **\`relay_room_brief\`** on the **\`relay\`** MCP server (stdio — installed by \`relay add\`).
2. Summarize peer chat, code edits, live locks, and the file-sync note for the user.
3. **Do not** tell the human to run a CLI command.

| Agent | Instructions file | Relay MCP config |
|-------|-------------------|------------------|
| **Cursor** | \`.cursor/rules/relay.mdc\`, \`.cursorrules\`, \`AGENTS.md\` | \`.cursor/mcp.json\` |
| **Claude Code** | \`CLAUDE.md\`, \`.claude/settings.json\` | \`.claude/settings.json\` → \`mcpServers.relay\` |
| **Codex** | \`AGENTS.md\` | \`.codex/config.toml\` → \`[mcp_servers.relay]\` |
| **Copilot CLI** | \`.github/copilot-instructions.md\` | \`.github/mcp.json\` |
| **Antigravity** | \`AGENTS.md\` | \`.agents/mcp_config.json\` |

If \`relay_room_brief\` is not in your tool list, Relay MCP is not connected — run \`relay add .\` from the repo root and restart this agent session.

## Other pseudo-commands

See the \`relay-os\` block in \`AGENTS.md\` / \`CLAUDE.md\` for \`/relay update\`, \`/relay context\`, and \`/relay init\`.
`;
}

module.exports = { RELAY_OS_BEGIN, RELAY_OS_END, relayOsBlock, agentBootstrap };
