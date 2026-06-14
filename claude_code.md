# Claude Code Persistent State & Memory Extraction

Based on a forensic analysis of the local environment for Claude Code (`~/.claude`), here is how Anthropic's CLI and Extension manages its state.

## 1. Storage Location & Session Management
All persistent state resides in the user's home directory:
`C:\Users\[Username]\.claude\`

Unlike Codex which embeds workspace mapping inside the file content, Claude Code maps workspaces structurally:
- **Location:** `~/.claude/projects/`
- **Mapping Mechanism:** The directory names are "slugified" absolute paths. For example, `C:\Users\Prakrititz Borah\Downloads\OrbitOS` becomes `c--Users-Prakrititz-Borah-Downloads-OrbitOS`.

## 2. Transcripts (The Execution Log)
- **Location:** `~/.claude/projects/[workspace_slug]/*.jsonl`
- **Format:** JSONL
- **Contents:** Contains the exact chat history and tool executions for specific threads.

## 3. Planning & Markdown Memory
Claude Code has an explicit planning system that outputs native Markdown.
- **Location:** `~/.claude/plans/*.md`
- **Purpose:** Claude generates and stores files here (e.g. `okay-right-now-v2-diff-cheeky-naur.md`) to keep track of multi-step plans. These files are highly valuable targets for Relay's Universal IR.

## 4. Undo Systems & File History
Claude Code implements a safety mechanism to rollback changes it makes to files.
- **Location:** `~/.claude/file-history/[project_uuid]/`
- **Purpose:** Stores complete backups of files *before* Claude edits them, allowing the CLI to easily undo mistakes without relying on the user's Git history.

## 5. Tool Execution & Shell Context
When Claude Code runs bash tools, it needs to remember the environment variables and directory state between commands.
- **Location:** `~/.claude/shell-snapshots/*.sh`
- **Purpose:** Shell scripts that snapshot the environment (like `snapshot-bash-1779594575806-v6or4f.sh`) so consecutive terminal commands run in the same context.

## 6. IDE vs CLI Sessions
Claude tracks active connections to prevent conflicts:
- **CLI:** `~/.claude/sessions/` tracks running terminal processes.
- **Extension:** `~/.claude/ide/` contains `.lock` files to track the VS Code extension's connection to the Claude backend.

## Conclusion
To fully reconstruct Claude Code's state for Relay:
1. **Transcripts:** Extract from `~/.claude/projects/[slug]/` (Already implemented).
2. **Plans:** Sync the markdown files in `~/.claude/plans/` as they represent the agent's high-level objectives.
3. **Rollbacks:** Monitor `~/.claude/file-history/` for diffs of what the AI changed.
