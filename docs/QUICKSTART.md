# Relay — Quick Start

One install gives you the CLI, agent hooks, `.relay/` scaffolding, and Mission Control UI.

---

## 1. Install in your project

```bash
cd your-project
npx relay-os init
```

**`relay init` installs everything:**

| What | Where |
|------|--------|
| `.relay/` IR markdown + memory | `.relay/project.md`, `current_task.md`, `decisions.md`, `failures.md` |
| Agent bootstrap | `.relay/AGENT_BOOTSTRAP.md`, `RELAY.md` |
| Stop hooks (all agents) | `.cursor/hooks.json`, `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/`, `.agents/hooks.json` |
| Patched instructions | `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules` |
| relay-sync skill | `.cursor/skills/relay-sync/` |
| Project registry + API key | `~/.relay-os/projects.json`, `.relay/project.json` |

Save the API key printed at init — Mission Control and MCP use it.

**Dependencies:** Node 18+ only. No MongoDB or login. Optional: install the **`sqlite3` CLI** on your PATH for fuller GitHub Copilot transcript sync (reads VS Code `state.vscdb` files).

---

## 2. Run Relay

```bash
npx relay-os serve          # API :3001 + Mission Control :6374
npx relay-os watch .        # background transcript sync
```

Open Mission Control at **http://localhost:6374** (printed by `relay init` / `relay serve`).

---

## 3. Work in any agent

Stop hooks run after each turn: `sync` → `compile_brief.md` → **you (the agent) update IR** → `relay context .`

| Agent | Hook config |
|-------|-------------|
| Cursor | `.cursor/hooks.json` |
| Claude Code | `.claude/settings.json` |
| Codex | `.codex/hooks.json` |
| Copilot CLI | `.github/hooks/relay-os.json` |
| Antigravity | `.agents/hooks.json` |

Disable hooks: `.relay/config.json` → `"autoAgentUpdate": false`

---

## 4. Pseudo-commands (in agent chat)

Not native slash commands — phrases agents recognize from patched instruction files:

| User says | Agent does |
|-----------|------------|
| `/relay update` | sync → compile → update IR from `compile_brief.md` → `relay context .` |
| `/relay context` | Read `.relay/relay_context.md` |
| `/relay init` | Run `npx relay-os init` if `.relay/` missing |

Terminal equivalent: `relay refresh .` ≈ `/relay update`

---

## 5. Switch agents

1. Finish work in agent A — stop hook or `/relay update` refreshes IR + handoff.
2. Open the **same folder** in agent B.
3. Type `/relay context` or let the agent read `.relay/relay_context.md` at session start.

---

## CLI reference

| Command | Purpose |
|---------|---------|
| `relay init [path]` | Scaffold `.relay/` + hooks + agent prompts |
| `relay install [path]` | Re-apply hooks after upgrade |
| `relay serve` | API + Mission Control UI |
| `relay serve --api-only` | API only |
| `relay watch [path]` | Background sync |
| `relay sync [path]` | Harvest transcripts → `memory.json` |
| `relay compile [path]` | Write `compile_brief.md` |
| `relay context [path]` | Generate `relay_context.md` handoff |
| `relay refresh [path]` | sync + compile + context |
| `relay mcp` | MCP server for `.relay` files (stdio) |
| `relay open` | Print UI + API URLs |
