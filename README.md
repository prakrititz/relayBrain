<div align="center">

![Relay](./logo.png)

### One project brain. Any coding agent.

*Git tracks your code. **Relay tracks your project intelligence** — tasks, decisions, failures, and what every agent did last session.*

**Switch tools without re-explaining the repo.**

<br/>

<a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-3c873a?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 18+"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=for-the-badge" alt="MIT"></a>
<img src="https://img.shields.io/badge/storage-files%20only-64748b?style=for-the-badge" alt="No database">
<img src="https://img.shields.io/badge/login-not%20required-16a34a?style=for-the-badge" alt="No login">

<br/>
<br/>

**Works with**

<p align="center">
  <img src="./support_images/readme/cursor.png" alt="Cursor" height="46" />
  <img src="./support_images/readme/claude.png" alt="Claude Code" height="46" />
  <img src="./support_images/readme/copilot.png" alt="GitHub Copilot" height="46" />
  <br />
  <img src="./support_images/readme/codex.png" alt="Codex" height="46" />
  <img src="./support_images/readme/antigravity.png" alt="Google Antigravity" height="46" />
</p>

</div>

---

## 🤔 The problem

You brief **Cursor** on Monday. Wednesday you switch to **Claude Code** — and start from zero. Every agent keeps its own little memory file (`CLAUDE.md`, `.cursorrules`, `copilot-instructions.md`, …), none of them talk to each other, and *you* become the human clipboard carrying context between tools.

## ✨ The fix

Relay keeps **one shared `.relay/` brain** that every agent reads and writes — and patches each agent's instruction file to point at it automatically.

```diff
- 5 agents · 5 memory files · 0 shared context
+ 5 agents · 1 project brain · always in sync
```

> **One install** gives you the CLI, stop hooks, agent prompts, the relay-sync skill, `.relay/` scaffolding, the Mission Control UI, and an optional MCP server.

---

## 🚀 Quick start

```bash
cd your-project
relay init          # .relay/, hooks, prompts, API key
relay serve         # Mission Control → :6374  ·  API → :3001
relay watch .       # background sync (keep running)
```

Work in **any** agent. Stop hooks (or `/relay update`) refresh the IR markdown. Switch agents → `/relay context` or just read `.relay/relay_context.md`.

<details>
<summary><strong>📦 Install options</strong></summary>

<br/>

| Method | Command |
|--------|---------|
| npm | `relay init` |
| local dev | `npm i`, then `npm link` in this repo, then `relay init` |
| GitHub | `npx github:AspiringPianist/OrbitOS init` |

Requires **Node.js 18+**. No database. First `relay serve` installs Mission Control deps automatically.

</details>

---

## 🧠 How it works

```text
  Cursor ──┐
  Claude ──┤   stop hooks + watch     ┌─────────────┐
  Copilot ─┼──► sync ──► memory.json ─►│  .relay/    │──► relay_context.md
  Codex ───┤         compile_brief     │  IR .md     │         │
  Antigravity ┘      (agent updates)   └─────────────┘         ▼
                                                          next agent reads handoff
```

| Layer | Who runs it | Output |
|-------|-------------|--------|
| **🔄 Sync** | `relay watch`, stop hook, `relay sync` | `memory.json` + timeline |
| **📝 Compile** | same | `compile_brief.md` |
| **🧩 IR update** | **you / the session agent** | `project.md`, `decisions.md`, … |
| **🤝 Handoff** | `relay context` | `relay_context.md` |

> `relay watch` = sync + compile only · `relay refresh` = sync + compile + context

---

## 📂 What `relay init` creates

```text
your-project/
├── .relay/
│   ├── AGENT_BOOTSTRAP.md       ← read every session
│   ├── relay_context.md         ← handoff file
│   ├── compile_brief.md         ← agent reads to update IR
│   ├── project.md · current_task.md · decisions.md · failures.md
│   ├── memory.json              ← unified timeline
│   ├── project.json             ← API key + dashboard URL
│   └── hooks/
├── RELAY.md
├── CLAUDE.md · AGENTS.md · .github/copilot-instructions.md · .cursorrules
├── .cursor/hooks.json + .cursor/skills/relay-sync/
├── .claude/settings.json · .codex/hooks.json · .agents/hooks.json
```

Registry (all projects): `~/.relay-os/projects.json`

---

## ⌨️ Commands

| Command | Description |
|---------|-------------|
| `relay init [path]` | Scaffold `.relay/`, hooks, agent patches, API key |
| `relay install [path]` | Re-apply hooks after upgrade |
| `relay serve` | Mission Control (:6374) + API (:3001) |
| `relay watch [path]` | Background sync + compile |
| `relay sync [path]` | Harvest transcripts → `memory.json` |
| `relay compile [path]` | Write `compile_brief.md` |
| `relay context [path]` | Generate `relay_context.md` |
| `relay refresh [path]` | sync + compile + context |
| `relay mcp` | MCP server (stdio) — optional |
| `relay open` | Print UI + API URLs |

**Pseudo-commands** — patched into agent instructions, *not* native slash commands:

| Say | Agent does |
|-----|------------|
| `/relay update` | sync → compile → update IR → `relay context .` |
| `/relay context` | read `.relay/relay_context.md` |
| `/relay init` | run `relay init` if missing |

> Terminal shortcut: `relay refresh .` ≈ `/relay update`

---

## 🎛️ Mission Control

Started by `relay serve` — runs locally, no login.

| | URL |
|---|-----|
| 🖥️ Dashboard | http://localhost:6374 |
| 🔌 API | http://localhost:3001/api/health |

Activity timeline across all agents · live IR markdown · per-project API keys.

---

## 🔧 MCP (optional)

Give agents **direct tool access** to `.relay/` — list files, read/write IR markdown, sync, fetch handoff.

> **Tools exposed:** `relay_list_files` · `relay_read_file` · `relay_write_file` · `relay_get_context` · `relay_sync`

Hooks + pseudo-commands are enough for most workflows. MCP is for agents where you want structured file tools on top.

<details>
<summary><strong>1 · Get your paths</strong></summary>

<br/>

After `relay init`, note:

- **Project path** — absolute path to your repo
- **API key** — printed at init (also in `.relay/project.json`) — only needed for remote mode

</details>

<details>
<summary><strong>2 · Base config</strong></summary>

<br/>

Always set `RELAY_WORKSPACE_PATH` to your project root (required — MCP may not inherit the right cwd):

```json
"env": {
  "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
}
```

**Local mode** (reads/writes `.relay/` on disk — default):

```json
{
  "command": "npx",
  "args": ["-y", "relay-os", "mcp"],
  "env": {
    "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
  }
}
```

If `relay` is on your PATH (`npm link` / global install):

```json
{
  "command": "relay",
  "args": ["mcp"],
  "env": {
    "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
  }
}
```

**Remote mode** (via `relay serve` API — useful when UI/API is already running):

```json
{
  "command": "npx",
  "args": ["-y", "relay-os", "mcp"],
  "env": {
    "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project",
    "RELAY_API_URL": "http://localhost:3001",
    "RELAY_API_KEY": "relay_your_key_from_init"
  }
}
```

</details>

<details>
<summary><strong>3 · Register per agent</strong></summary>

<br/>

**Cursor** — `.cursor/mcp.json` (project) or user MCP settings

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["-y", "relay-os", "mcp"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
      }
    }
  }
}
```

Restart Cursor or reload MCP. Relay tools appear in Agent mode.

**Claude Code** — `.mcp.json` (project) or `~/.claude.json`

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["-y", "relay-os", "mcp"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
      }
    }
  }
}
```

Or via CLI: `claude mcp add relay -- npx -y relay-os mcp` (set env in config after).

**GitHub Copilot** — VS Code `.vscode/mcp.json` or Copilot CLI MCP config

VS Code / Copilot (`mcp.json`):

```json
{
  "servers": {
    "relay": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "relay-os", "mcp"],
      "env": {
        "RELAY_WORKSPACE_PATH": "${workspaceFolder}"
      }
    }
  }
}
```

Copilot CLI — add to your MCP config file per [Copilot MCP docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp):

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["-y", "relay-os", "mcp"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
      }
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml` or project config

```toml
[mcp_servers.relay]
command = "npx"
args = ["-y", "relay-os", "mcp"]

[mcp_servers.relay.env]
RELAY_WORKSPACE_PATH = "/absolute/path/to/your-project"
```

**Antigravity** — MCP settings (same JSON shape as Cursor)

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["-y", "relay-os", "mcp"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/absolute/path/to/your-project"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>4 · Test MCP</strong></summary>

<br/>

```bash
# Should print: relay-mcp started (local mode, workspace: ...)
RELAY_WORKSPACE_PATH=/path/to/project relay mcp
```

</details>

---

## 🎬 Example: three agents, one portfolio

> **Day 1 — Cursor** builds the hero. Stop hook runs. You type `/relay update`.

```markdown
## Now   ← .relay/current_task.md
- Hero done (gradient + CTA)
- Next: projects grid
```

> **Day 2 — Claude Code** opens the same folder. `/relay context` → implements the grid without re-briefing.

> **Day 3 — Copilot CLI** fixes form validation, appends to `.relay/failures.md`.

With `relay serve` + `relay watch .` running, Mission Control shows **all three agents on one timeline**.

**🔁 Switch checklist:** `/relay update` → open same folder in new tool → `/relay context`

---

## 📦 Dependencies

| | |
|---|---|
| ✅ **Required** | Node.js 18+, npm |
| ⚙️ **Auto-installed** | `express`, `cors` (API) · `next`, `react` (Mission Control) |
| 🚫 **Not needed** | MongoDB, Redis, Docker, login/OAuth |
| 🧩 **Optional** | [`sqlite3` CLI](https://sqlite.org/download.html) on PATH — richer Copilot sync via VS Code `state.vscdb` (not an npm package) |
| 🔑 **Optional LLM keys** | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` for smarter `relay compile-ir` (heuristics work without) |

**Storage:** `.relay/` in your project + `~/.relay-os/projects.json` — files only, no DB server.

**Env vars:** `RELAY_PORT` (3001) · `RELAY_UI_PORT` (6374) · `RELAY_API_KEY` (optional API auth) · `RELAY_SKIP_UI_INSTALL=1`

---

## 🪝 Stop hooks

Installed in your **project folder** by `relay init`:

| Agent | Config |
|-------|--------|
| Cursor | `.cursor/hooks.json` |
| Claude Code | `.claude/settings.json` |
| Codex | `.codex/hooks.json` |
| Copilot CLI | `.github/hooks/relay-os.json` |
| Antigravity | `.agents/hooks.json` |

Disable: `.relay/config.json` → `"autoAgentUpdate": false`

---

## 📚 Docs

[docs/QUICKSTART.md](docs/QUICKSTART.md)

---

<div align="center">

**🛰️ Git tracks code. Relay tracks what your agents know about the project.**

<sub>MIT licensed · Built for teams that switch tools mid-flight.</sub>

</div>
