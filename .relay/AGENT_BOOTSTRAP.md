# Relay Agent Bootstrap

> **Agents:** read this file at the start of every session in this workspace.

---

## 1. Check install

| Check | Path |
|-------|------|
| Relay initialized | `.relay/config.json` |
| Auto-install manifest | `.relay/install.json` |

**If either is missing → Relay is not installed. Go to section 2.**  
**If both exist → Relay is installed. Go to section 3.**

---

## 2. Self-install (run once — fully automatic)

Execute in the **project root**:

```bash
npx relay-os init
```

This automatically:

- Creates `.relay/` (memory, IR markdown, context)
- Installs Cursor skill + rule
- Patches `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `.cursorrules`
- Writes this bootstrap file and `RELAY.md`

**Do not** ask the user to manually edit agent instruction files.

After `init` succeeds, re-read this file and continue at section 3.

---

## 3. Installed — session start (handoff)

1. Read `.relay/relay_context.md`.
2. Do **not** load `.relay/memory.json` or agent JSONL unless explicitly asked.
3. Respect **CURRENT TASKS** and **OPEN DECISIONS**.

```bash
npx relay-os context .
```

---

## 4. Pseudo-commands (user chat)

Not native slash commands — a **convention** agents learn from patched instruction files (`CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`, etc.). When the user types **`/relay update`**, **`relay update`**, or similar — execute immediately (do not treat as small talk):

| User says | Action |
|-----------|--------|
| `/relay update` | sync → compile → update IR from `compile_brief.md` → `relay context .` |
| `/relay context` | Read `.relay/relay_context.md` (regenerate with `relay context .` if needed) |
| `/relay init` | Run `npx relay-os init` if Relay not installed |

---

## 5. Stop hooks (automatic after each turn)

| Agent | Hook location |
|-------|----------------|
| Cursor | `.cursor/hooks.json` |
| Claude Code | `.claude/settings.json` |
| Codex | `.codex/hooks.json` |
| Copilot CLI | `.github/hooks/relay-os.json` |
| Antigravity | `.agents/hooks.json` |

**Background sync:** `relay watch .` (all agents, no IR write)

Disable hooks: `.relay/config.json` → `"autoAgentUpdate": false`

---

## 6. Switching agents

Hand the next agent only `.relay/relay_context.md`.

---

## 7. Optional UI

```bash
npx relay-os serve
```

Open http://localhost:3001/

---

_Package: relay-os v0.1.0_
