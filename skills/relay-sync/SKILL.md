---
name: relay-sync
description: >-
  Relay cross-agent memory. Pseudo-commands (not native slash cmds): /relay update, /relay context, /relay init.
  Stop hooks + relay watch. Read relay_context.md at session start.
---

# Relay Sync

## Pseudo-commands (recognize in user chat)

Not built-in slash commands — a project convention the user types so you recognize Relay intent (also documented in `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.relay/AGENT_BOOTSTRAP.md`).

| User says | Do this |
|-----------|---------|
| `/relay update` or `relay update` | `relay sync .` → `relay compile .` → read `compile_brief.md` → update IR markdown → `relay context .` |
| `/relay context` or `relay context` | Read `.relay/relay_context.md` |
| `/relay init` or `relay init` | Run `npx relay-os init` if missing |

Reply briefly when done (e.g. "Relay updated.").

## Session start

Read `.relay/relay_context.md` only.

## Background

`relay watch .` — syncs all agents.

## Handoff

Next agent reads `.relay/relay_context.md`.
