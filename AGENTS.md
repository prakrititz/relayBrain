<!-- BEGIN:relay-os -->
# Relay (auto-installed)

This project uses **Relay** for cross-agent memory. Do not ask the user to configure agent files manually.

**Every session — read first:** `.relay/AGENT_BOOTSTRAP.md`

| Phase | Action |
|-------|--------|
| Session start | Read `.relay/relay_context.md` (handoff). Never paste raw transcripts. |
| After agent work | **You** update `.relay/*.md` from `compile_brief.md` (stop hook triggers this) |
| Background sync | `relay watch .` keeps `memory.json` + `compile_brief.md` fresh |
| Not installed? | Run `npx relay-os init` in project root |

**Stop hooks:** Cursor, Claude Code, Codex, Copilot CLI, Antigravity — installed by `relay init`.

## Relay pseudo-commands (user chat)

These are **not** built-in slash commands in Cursor, Claude, Copilot, etc. They are a **project convention** — phrases the user types so agents recognize Relay intent. `relay init` patches this block into `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules`, and `.relay/AGENT_BOOTSTRAP.md`.

When the user sends any of these phrases (with or without a leading `/`), treat them as Relay instructions — not casual chat:

| User says | You do |
|-----------|--------|
| `/relay update` or `relay update` | `relay sync .` → `relay compile .` → read `.relay/compile_brief.md` → update `.relay/project.md`, `current_task.md`, `decisions.md`, `failures.md` → `relay context .` → confirm "Relay updated." |
| `/relay context` or `relay context` | Read `.relay/relay_context.md` (run `relay context .` first if stale). Summarize handoff briefly. |
| `/relay init` or `relay init` | Run `npx relay-os init` in project root if `.relay/` missing; else confirm already installed. |

Use `npx relay-os` if `relay` is not on PATH. Do not ask the user to edit agent config files manually.

Cursor: `@relay-sync` skill at `.cursor/skills/relay-sync/`.
<!-- END:relay-os -->
