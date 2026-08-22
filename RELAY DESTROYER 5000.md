# Relay: Multi-Agent Collaboration & Synchronization Protocol

## Overview
Relay is a novel synchronization and coordination protocol designed to solve file clashes and manage concurrency when multiple AI agents and human developers operate on the same Git repository. Relay provides real-time locking, dependency-aware conflict resolution, and shared AI context, enabling massive parallelization of software development tasks across both intra-user (local) and inter-user (distributed) environments.

## Core Features

### 1. Seamless Onboarding & Repository Management
- **CLI & Dashboard integration:** Installed via standard package managers (`npm install relay`), users authenticate using GitHub single sign-on (`relay login`) and clone repositories using the custom `relay clone` wrapper.
- **Centralized Coordinator:** A Backend Coordinator Service tracks active users, repository states, and connected AI agents. This data is visualized via the Relay web dashboard, providing real-time observability of who is working on what.

### 2. Universal AI Context Sharing
- **Cross-Tool History Extraction:** Relay natively integrates with popular AI coding assistants (Claude Code, Antigravity, Codex, Cursor, GitHub Copilot, etc.).
- **Shared Memory:** By extracting and aggregating local IDE chat logs, file edits, and agent contexts, Relay constructs a unified, real-time shared history. Any developer or agent can access the context of what other agents have discussed, explored, or modified, ensuring global alignment and preventing redundant work.

### 3. Concurrency & Coordination — The Deep Dive

> **The core idea in one sentence:** Relay is a traffic controller for code edits — it makes sure no two hands (human or AI) touch the same wire at the same time, whether those hands are on the same machine or across the planet.

Relay operates at two distinct levels:

| Level | Scope | Where it runs | Think of it as… |
|-------|-------|---------------|-----------------|
| **Intra-Coordination** | One user, many agents | Locally on your machine | A single kitchen, many chefs |
| **Inter-Coordination** | Many users, many agents | Distributed across machines via the Relay Coordinator | Many kitchens, one restaurant |

---

## 3A. Intra-Coordination (Single-User, Multi-Agent)

> **Analogy — The Single Kitchen:** You have one kitchen (your repo) and you've hired five chefs (AI agents). They're all brilliant, but if two of them grab the same pan at the same time, someone's getting burned. Intra-Coordination is the head chef calling out "Hands off the sauté pan, Chef B — Chef A has it!"

### How It Works

When you spin up multiple agent instances on the same codebase (e.g., three Cursor tabs + a Claude Code session), each agent's tool calls pass through a **Relay Local Daemon** — a lightweight background process that acts as a single source of truth for file state.

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Agent 1  │  │ Agent 2  │  │ Agent 3  │
│ (Cursor) │  │ (Claude) │  │ (Codex)  │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     │             │             │
     │  MCP / Pre-Tool Hooks     │
     ▼             ▼             ▼
┌────────────────────────────────────────┐
│        Relay Local Daemon              │
│  ┌────────────┐  ┌──────────────────┐  │
│  │ Lock Table │  │ Dependency Graph │  │
│  └────────────┘  └──────────────────┘  │
└────────────────────────────────────────┘
```

### Case 1 — Direct File Collision (The Obvious One)

**Scenario:** Agent A starts editing `src/auth.ts`. Agent B also wants to edit `src/auth.ts`.

**What happens:**
1. Agent A's pre-tool hook fires → Relay Daemon grants a **write lock** on `src/auth.ts` → Agent A proceeds.
2. Agent B's pre-tool hook fires → Relay Daemon sees `src/auth.ts` is locked → **Agent B is blocked.**
3. Agent B receives a structured message: *"File `src/auth.ts` is currently being edited by Agent A (Cursor, pid 4821). Waiting for release…"*
4. Agent A finishes its edit → lock is released → Agent B is unblocked and picks up the latest version of the file.

> **Edge Case — Stale Lock / Agent Crash:** If Agent A crashes mid-edit, the lock would be orphaned forever. Relay handles this with a **heartbeat + TTL system**: each lock has a time-to-live (default: 60s) and the holding agent must send periodic heartbeats. If the heartbeat stops, the daemon force-releases the lock and notifies waiting agents.

> **Edge Case — Read vs. Write:** Agents that only *read* a file (e.g., to gather context) do NOT acquire a write lock. Relay uses a **reader-writer lock model**: unlimited concurrent reads, but writes are exclusive. An agent reading `auth.ts` won't block another agent from also reading it — only writes trigger exclusivity.

### Case 2 — Dependency Collision (The Sneaky One)

**Scenario:** Agent A edits `src/utils/logger.ts`. Agent B is editing `src/api/handler.ts`, which `import`s from `logger.ts`.

**Why this is dangerous:** Agent A might rename a function, change its signature, or delete an export. If Agent B is simultaneously writing code that *calls* that function, Agent B's work will silently break.

**What happens:**
1. On repo initialization, the Relay Daemon builds a **live dependency graph** by parsing `import`/`require`/`include` statements (supports TS, JS, Python, Go, Rust, Java, and more via tree-sitter).
2. When Agent A locks `logger.ts`, the daemon traverses the graph and identifies all **downstream dependents** (files that import from `logger.ts`).
3. Agent B's attempt to edit `handler.ts` is intercepted. The daemon issues a **soft lock** — Agent B receives: *"⚠️ `handler.ts` depends on `logger.ts`, which is currently being modified by Agent A. Proceeding may cause inconsistencies. Waiting for Agent A to finish…"*
4. Once Agent A releases its lock, the daemon re-indexes the changed file and Agent B receives the updated dependency information before resuming.

```
  logger.ts  ← Agent A editing (WRITE LOCK)
      │
      ├── handler.ts  ← Agent B blocked (SOFT LOCK - dependent)
      ├── middleware.ts  ← Any agent blocked (SOFT LOCK - dependent)
      └── tests/logger.test.ts  ← Any agent blocked (SOFT LOCK - dependent)
```

> **Edge Case — Circular Dependencies:** If `A.ts` imports `B.ts` and `B.ts` imports `A.ts`, editing either file would soft-lock the other. Relay detects circular dependency clusters and treats them as a **single lockable unit** — only one agent can work on any file in the cycle at a time.

> **Edge Case — Deep Transitive Dependencies:** If `A → B → C → D`, does editing `A` lock all the way to `D`? **Configurable.** By default, Relay applies a **depth limit of 1** (only direct dependents). Users can configure `relay.lock.depth` to increase this, trading parallelism for safety.

> **Edge Case — Dynamic Imports / Runtime Dependencies:** Static analysis can't catch `await import(variable)` or Python's `importlib`. Relay flags these as **unresolvable edges** in the graph and logs a warning, but does not lock based on them. Users can manually declare additional dependency edges in a `.relay/deps.json` override file.

### Case 3 — Multi-File Atomic Edits (The Refactoring Bomb)

**Scenario:** Agent A is doing a cross-cutting refactor — renaming a type across 12 files simultaneously.

**What happens:**
1. Agent A's tool call declares an **atomic batch** — a set of files that must be edited together.
2. The daemon acquires write locks on ALL 12 files as a single transaction (all-or-nothing — if any file is already locked, the entire batch waits).
3. Other agents are blocked from editing any of the 12 files until the batch completes.
4. If the batch fails midway, all partial edits are rolled back and all locks are released.

> **Edge Case — Deadlock:** Agent A holds `file1.ts` and wants `file2.ts`. Agent B holds `file2.ts` and wants `file1.ts`. Classic deadlock. Relay prevents this with **lock ordering** — all batch lock requests are sorted alphabetically by filepath and acquired in order, making circular wait impossible.

---

## 3B. Inter-Coordination (Multi-User, Multi-Agent)

> **Analogy — The Restaurant Chain:** Now imagine you have five kitchens in five different cities, all cooking for the same restaurant brand. They share the same menu (codebase), and if the Tokyo kitchen changes the recipe for the signature dish, every other kitchen needs to know *instantly* — otherwise customers get different food depending on which city they're in. Inter-Coordination is the radio network connecting all the kitchens.

### How It Works

Each user's machine runs a **Relay Local Daemon** (just like in Intra mode), but now each daemon also maintains a persistent **WebSocket connection** to the **Relay Coordinator Service** (cloud-hosted or self-hosted). The Coordinator is the single source of truth for distributed lock state.

```
  User A's Machine                    User B's Machine
┌──────────────────┐              ┌──────────────────┐
│  Agent 1  Agent 2│              │  Agent 3  Agent 4│
│    ↓         ↓   │              │    ↓         ↓   │
│  Local Daemon    │              │  Local Daemon    │
│  (lock table +   │              │  (lock table +   │
│   dep graph)     │              │   dep graph)     │
└───────┬──────────┘              └───────┬──────────┘
        │ WebSocket                       │ WebSocket
        ▼                                 ▼
┌─────────────────────────────────────────────────────┐
│              Relay Coordinator Service               │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │ Global Lock Table │  │ Patch Stream (pub/sub) │  │
│  └──────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Case 1 — Cross-User File Collision

**Scenario:** User A's agent starts editing `src/auth.ts`. User B's agent also wants to edit `src/auth.ts`.

**What happens:**
1. User A's daemon sends a lock request to the Coordinator → lock granted → propagated to all connected daemons.
2. User B's daemon receives the lock event → updates its local lock table → User B's agent is blocked with a message: *"File `src/auth.ts` is locked by User A (@alice, Cursor instance). Waiting…"*
3. User A's agent finishes → daemon releases lock → Coordinator broadcasts release → User B's agent unblocks.

> **Edge Case — User Goes Offline Mid-Lock:** User A's laptop lid closes. The WebSocket drops. The Coordinator detects the disconnect and starts a **grace period** (default: 120s). If User A reconnects within the grace period, locks are preserved. If not, all of User A's locks are force-released and other users are notified: *"User A went offline. Locks released. Warning: `auth.ts` may contain partial edits."*

> **Edge Case — Network Partition (Split Brain):** Users A and B can both reach the Coordinator, but a network blip causes User C's daemon to lose connection. During the partition, User C operates in **degraded local-only mode** — intra-coordination still works, but inter-locks are frozen. On reconnect, the daemon performs a **lock reconciliation** with the Coordinator, resolving any conflicts.

### Case 2 — Cross-User Dependency Collision

Identical logic to Intra Case 2, but the dependency graph is **merged at the Coordinator level**. Each daemon uploads its local dependency graph on connect and on file changes. The Coordinator maintains a unified supergraph.

> **Edge Case — Graph Divergence:** User A has pulled the latest `main`, but User B is 3 commits behind. Their dependency graphs differ. The Coordinator resolves this by maintaining **per-user graph snapshots** and computing lock decisions based on the *union* of all known edges — if a dependency exists in *any* user's graph, it's respected.

### Case 3 — Real-Time Patch Delivery (The Speed Layer)

**The problem with git push/pull:** A typical agent edit cycle is: edit file → save → `git add` → `git commit` → `git push`. Meanwhile, User B has to `git pull`, resolve potential merge conflicts, and restart their agent's context. This loop takes **seconds to minutes** per edit cycle. With agents making dozens of edits per minute, this is unacceptable.

**Relay's solution — Streaming Patches:**

1. When an agent saves a file, the daemon computes a **minimal diff (patch)** against the last known state.
2. The patch is sent to the Coordinator, which broadcasts it to all other daemons via the WebSocket pub/sub channel.
3. Receiving daemons apply the patch to the local file instantly — **no git ceremony required**.
4. Patches are queued and periodically batched into proper git commits in the background (configurable interval).

```
Agent A edits auth.ts
        │
        ▼
  Daemon A computes diff:
    @@ -12,3 +12,5 @@
    + import { verify } from './jwt';
    + const token = verify(req.headers.auth);
        │
        ▼ WebSocket
  Coordinator broadcasts patch
        │
   ┌────┴────┐
   ▼         ▼
Daemon B   Daemon C
applies    applies
patch      patch
locally    locally
```

> **Edge Case — Conflicting Patches:** User A and User B both edit line 42 of the same file simultaneously (lock failed or race condition). The Coordinator detects the conflict using **Operational Transformation (OT)** — the same algorithm behind Google Docs. Both patches are transformed to be compatible and applied in a deterministic order. If transformation is impossible (e.g., both deleted the same block differently), the Coordinator flags a **manual merge** and pauses both agents.

> **Edge Case — Ordering & Causality:** Patches must be applied in the correct order. Relay uses **Lamport timestamps** on every patch to establish a total causal order. If Daemon B receives Patch #5 before Patch #4 (out of order), it buffers Patch #5 and waits for #4.

> **Edge Case — Large Binary Files:** Diffs don't make sense for images, compiled assets, or model weights. Relay detects binary files and falls back to **whole-file replacement** with content-addressed storage (SHA-256 hash). If the hash matches, the file is skipped entirely.

> **Edge Case — Offline Patch Queue:** If a user goes offline, their daemon queues patches locally. On reconnect, the queue is replayed to the Coordinator in order. The Coordinator applies them sequentially, resolving any conflicts that arose during the offline window.

### Case 4 — Lock Escalation (Intra → Inter)

**Scenario:** You start working solo (Intra mode only). A teammate joins the repo.

**What happens:**
1. Your daemon detects a new user connecting to the same repo via the Coordinator.
2. All existing local locks are **escalated** — they're registered with the Coordinator so the new user's daemon is aware of them.
3. From this point on, all new lock requests go through the Coordinator (Inter mode).
4. If the teammate disconnects and you're alone again, the daemon **de-escalates** back to local-only mode for lower latency.

> **Edge Case — Race During Escalation:** A lock is held locally but hasn't been registered with the Coordinator yet when a remote user requests the same file. The Coordinator uses a **compare-and-swap (CAS)** protocol — the first lock registration wins, and the loser is notified and queued.

---

## Coordination Summary — All Cases at a Glance

| # | Case | Level | Lock Type | Resolution |
|---|------|-------|-----------|------------|
| 1 | Two agents edit the same file | Intra | Write mutex | Queue — second agent waits |
| 2 | Agent edits a file's dependency | Intra | Soft lock (dependent) | Second agent paused until upstream done |
| 3 | Multi-file atomic refactor | Intra | Batch lock (all-or-nothing) | Sorted lock ordering prevents deadlocks |
| 4 | Two users' agents edit the same file | Inter | Distributed write mutex | Coordinator arbitrates, WebSocket propagation |
| 5 | Cross-user dependency collision | Inter | Distributed soft lock | Union dependency graph at Coordinator |
| 6 | Real-time sync of edits | Inter | N/A (streaming) | OT-based patch delivery over WebSocket |
| 7 | User goes offline | Inter | Grace period + force-release | Configurable TTL, reconnect reconciliation |
| 8 | Solo → team transition | Escalation | Local → distributed | CAS-based lock registration |

### Edge Cases — Quick Reference

| Edge Case | Solution |
|-----------|----------|
| Agent crashes mid-lock | Heartbeat + TTL auto-release |
| Circular dependencies | Treated as single lock unit |
| Deep transitive deps | Configurable depth limit (default: 1) |
| Dynamic imports | Flagged as unresolvable; manual override via `.relay/deps.json` |
| Deadlock (lock ordering) | Alphabetical lock acquisition |
| User offline mid-lock | Grace period (120s default), then force-release |
| Network partition | Degraded local-only mode, reconciliation on reconnect |
| Conflicting patches | Operational Transformation (OT) or manual merge |
| Out-of-order patches | Lamport timestamp ordering with buffering |
| Binary files | Whole-file replacement with SHA-256 dedup |
| Graph divergence (stale deps) | Union of all user graphs at Coordinator |
| Race during lock escalation | Compare-and-swap (CAS) — first registration wins |

### 4. Advanced Versioning & "Time Travel"
- **Granular Patch History:** Because every edit is transmitted as a localized micro-patch, Relay maintains a high-resolution, immutable timeline of all repository changes outside of standard Git commits.
- **Patch Replay & Rollback:** Users can rewind to any specific patch, reviewing the exact atomic changes made by any human or AI agent on any file, providing unparalleled observability and surgical rollback capabilities.

---

## 5. Pre-Tool Hooks — The Interception Layer

> **This is the single most important mechanism in Relay.** Everything described above — file locking, dependency locking, distributed coordination — is enforced through **pre-tool hooks**. Without hooks, the coordination layer has no teeth. Hooks are the hands that actually grab the steering wheel.

### What Are Pre-Tool Hooks?

Every modern AI coding agent follows the same execution loop:

```
User prompt → Agent thinks → Agent calls a TOOL → Tool executes → Result
```

A **pre-tool hook** is a script that intercepts the `Agent calls a TOOL` step — right before the tool (file write, shell command, etc.) actually runs. The hook receives the tool call details via `stdin`, decides whether to **allow** or **deny** the operation, and writes the decision to `stdout`.

```
                            ┌──────────────────────┐
User prompt → Agent thinks  │  PRE-TOOL HOOK       │
                    │       │  ┌──────────────────┐ │
                    ▼       │  │ Parse stdin JSON  │ │
              Tool call ───►│  │ Extract file path │ │
                            │  │ Check lock table  │ │
                            │  │ Return allow/deny │ │
                            │  └──────────────────┘ │
                            └──────────┬───────────┘
                                       │
                              ┌────────┴────────┐
                              ▼                 ▼
                          ALLOWED           DENIED
                        (tool runs)    (agent told why,
                                        picks new task)
```

### Universal Hook Protocol

Despite each agent having a slightly different config format, **every hook follows the same protocol**:

1. **Trigger:** The agent is about to call a file-write tool (`Edit`, `Write`, `Replace`, etc.)
2. **Matcher:** A regex filter decides if this specific tool name should fire the hook
3. **Execution:** The agent spawns the hook script as a child process
4. **Input:** The agent pipes a JSON payload to the hook's `stdin` containing tool name, file path, session ID, and workspace context
5. **Decision:** The hook writes a JSON response to `stdout` with an allow/deny decision
6. **Enforcement:** If denied, the agent receives the reason and must choose a different action

### Hook Lifecycle — Both Events

Relay installs **two** hook events per agent:

| Event | When it fires | What Relay does |
|-------|---------------|-----------------|
| `PreToolUse` | Before any file-write tool executes | **Claim a lock** on the target file. If another agent holds the lock → deny. |
| `Stop` | When the agent's turn ends (idle / done) | **Release all locks** held by this agent. Run `relay sync` + `relay compile` to update shared memory. |

---

## 5A. Configuration Files — Per Agent

Each agent has its own config file format. `relay init` generates all of these automatically.

---

### Claude Code

**Config file:** `.claude/settings.json`
**Scope:** Project-level (repo root) or global (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Replace",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-claude-pre-tool.js\""
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-claude-stop.js\""
          }
        ]
      }
    ]
  }
}
```

**Key details:**
- **Matcher:** Pipe-delimited tool names (`Edit|Write|Replace`). Use `*` for all tools.
- **Nesting:** `hooks` → `EventName` → `[{ matcher, hooks: [{ type, command }] }]` (three levels deep).
- **Deny protocol:** Exit code `2` + message on `stderr`. The message is injected back into Claude's context.
- **Allow protocol:** Exit code `0` + optional JSON on `stdout`.

**stdin payload (from Claude Code):**
```json
{
  "session_id": "7d4c902d-...",
  "transcript_path": "~/.claude/projects/.../session.jsonl",
  "cwd": "/path/to/repo",
  "hook_event_name": "PreToolUse",
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/auth.ts",
    "old_string": "...",
    "new_string": "..."
  },
  "tool_use_id": "toolu_01M3Rw...",
  "permission_mode": "acceptEdits"
}
```

**stdout response (allow):**
```json
{ "continue": true }
```

**stdout response (deny):**
```json
{
  "continue": false,
  "stopReason": "Lock denied: Another agent (Cursor, session abc123) is editing this file."
}
```

---

### Cursor

**Config file:** `.cursor/hooks.json`
**Scope:** Project-level (repo root) or global (`~/.cursor/hooks.json`)

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "node \".relay/hooks/relay-cursor-pre-tool.js\"",
        "matcher": "Write|Edit|str_replace_based_edit_tool|create_file",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": "node \".relay/hooks/relay-cursor-stop.js\"",
        "loop_limit": 1
      }
    ]
  }
}
```

**Key details:**
- **Format differences:** Flat array (no nested `hooks` array). Uses `"version": 1`.
- **Event names:** camelCase (`preToolUse`, not `PreToolUse`).
- **Extra fields:** `timeout` (seconds), `loop_limit` (max re-fires on stop).
- **Matcher:** Pipe-delimited, includes Cursor-specific tool names like `str_replace_based_edit_tool`.

**stdin payload (from Cursor):**
```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "src/auth.ts",
    "target_file": "src/auth.ts"
  },
  "conversation_id": "conv-a1b2c3",
  "cwd": "/path/to/repo",
  "workspace_roots": ["/path/to/repo"]
}
```

**stdout response (allow):**
```json
{ "permission": "allow" }
```

**stdout response (deny):**
```json
{
  "permission": "deny",
  "reason": "Relay lock denied: Another agent (Claude Code, session xyz) is editing this file."
}
```

---

### OpenAI Codex CLI

**Config file:** `.codex/hooks.json`
**Scope:** Project-level (repo root) or global (`~/.codex/hooks.json`)
**Prerequisite:** Hooks must be enabled in `~/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Replace",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-codex-pre-tool.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-codex-stop.js\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**Key details:**
- **Schema:** Identical to Claude Code's three-level nesting (`hooks` → `EventName` → `[{ matcher, hooks }]`).
- **Event names:** PascalCase (`PreToolUse`, `Stop`).
- **Deny protocol:** `exit(2)` or JSON response with `{ "continue": false }`.
- **Trust model:** Project-scoped hooks only load if the repo is marked as **trusted**.

**stdin payload (from Codex):**
```json
{
  "session_id": "codex-sess-...",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {
    "file_path": "src/auth.ts",
    "content": "..."
  },
  "cwd": "/path/to/repo"
}
```

**stdout response (allow):**
```json
{ "continue": true }
```

**stdout response (deny):**
```json
{
  "continue": false,
  "stopReason": "Relay lock denied: Another agent (Antigravity, session def456) is editing this file."
}
```

---

### GitHub Copilot CLI

**Config file:** `.github/hooks/relay-os.json`
**Scope:** Repository-level (`.github/hooks/`)

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "node \".relay/hooks/relay-copilot-pre-tool.js\"",
        "powershell": "node \".relay/hooks/relay-copilot-pre-tool.js\"",
        "matcher": "edit_file|write_file|str_replace_editor",
        "cwd": ".",
        "timeoutSec": 10
      }
    ],
    "agentStop": [
      {
        "type": "command",
        "bash": "node \".relay/hooks/relay-copilot-stop.js\"",
        "powershell": "node \".relay/hooks/relay-copilot-stop.js\"",
        "cwd": ".",
        "timeoutSec": 120
      }
    ]
  }
}
```

**Key details:**
- **Cross-platform:** Requires BOTH `bash` and `powershell` commands (no single `command` field).
- **Event names:** camelCase (`preToolUse`, `agentStop` — note `agentStop` not `stop`).
- **Extra fields:** `cwd` (working directory), `timeoutSec` (not `timeout`).
- **Matcher:** Pipe-delimited, uses Copilot-specific tool names (`edit_file`, `write_file`, `str_replace_editor`).
- **Deny protocol:** Non-zero exit = deny (fail-closed by default for `preToolUse`).

**stdin payload (from Copilot):**
```json
{
  "tool_name": "edit_file",
  "tool_input": {
    "file_path": "src/auth.ts",
    "content": "..."
  },
  "toolInput": { "file_path": "src/auth.ts" },
  "session_id": "copilot-sess-...",
  "cwd": "/path/to/repo"
}
```

**stdout response (allow):**
```json
{ "behavior": "allow" }
```

**stdout response (deny):**
```json
{
  "behavior": "deny",
  "message": "Relay lock denied: Another agent (Cursor, session ghi789) is editing this file."
}
```

---

### Google Antigravity

**Config file:** `.agents/hooks.json`
**Scope:** Workspace-level (repo root)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*replace_file_content.*|.*write_to_file.*|.*multi_replace_file_content.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-antigravity-pre-tool.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node \".relay/hooks/relay-antigravity-stop.js\"",
        "timeout": 120
      }
    ]
  }
}
```

**Key details:**
- **Event names:** PascalCase (`PreToolUse`, `Stop`).
- **Matcher:** Full regex patterns (not simple pipe-delimited names). Antigravity tool names are verbose (`replace_file_content`, `write_to_file`, `multi_replace_file_content`).
- **Deny protocol:** JSON response with `hookSpecificOutput.permissionDecision` field.
- **Session ID:** Extracted from `SESSION_ID` env var or payload fields.

**stdin payload (from Antigravity):**
```json
{
  "TargetFile": "c:/path/to/repo/src/auth.ts",
  "toolCall": {
    "args": {
      "TargetFile": "c:/path/to/repo/src/auth.ts",
      "ReplacementContent": "..."
    }
  },
  "session_id": "5ef91f49-..."
}
```

**stdout response (allow):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow"
  }
}
```

**stdout response (deny):**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Relay lock denied: Another agent (Claude Code, session jkl012) is editing this file."
  }
}
```

---

## 5B. The Hook Script — What Actually Runs

All five agent-specific hook scripts are thin wrappers around the same shared library (`.relay/hooks/relay-hook-lib.js`). The core logic is identical:

```
                    ┌─────────────────────────────┐
                    │  Agent-Specific Wrapper      │
                    │  (relay-{agent}-pre-tool.js) │
                    │                              │
                    │  1. Read stdin JSON           │
                    │  2. Parse agent-specific      │
                    │     payload format            │
                    │  3. Extract file_path         │
                    │  4. Call shared lock logic     │
                    │  5. Format agent-specific     │
                    │     response                  │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Shared Library              │
                    │  (relay-hook-lib.js)         │
                    │                              │
                    │  • lockAgentIdFor(mode)      │
                    │  • client.claimFile(path)    │
                    │  • formatHolderLabel()       │
                    │  • resolveWorkspacePath()    │
                    └─────────────────────────────┘
                                   │
                                   ▼
                    ┌─────────────────────────────┐
                    │  Coordinator Client          │
                    │  (backend/coordinator/       │
                    │   client.js)                 │
                    │                              │
                    │  • claimFile() → lock table  │
                    │  • releaseAll() → cleanup    │
                    └─────────────────────────────┘
```

### Core Flow (Pseudocode)

```javascript
// 1. Read the JSON payload from the agent
const payload = JSON.parse(await readStdin());

// 2. Extract the file path (agent-specific field names)
const filePath = payload.tool_input?.file_path   // Claude, Codex, Copilot
              || payload.tool_input?.target_file  // Cursor
              || payload.TargetFile               // Antigravity
              || payload.toolCall?.args?.TargetFile;

// 3. Build a unique agent ID: "AgentLabel:machineId:sessionId"
const agentId = lockAgentIdFor(mode, payload);

// 4. Attempt to claim the file lock
const result = await coordinator.claimFile(workspacePath, agentId, filePath);

// 5. Respond
if (result.allowed === false) {
  respond_deny(`Locked by ${result.holder}. Pick a different file.`);
} else {
  respond_allow();
}
```

### Fail-Open Philosophy

> **Critical design decision:** If anything goes wrong — JSON parse error, coordinator unreachable, timeout, unexpected payload format — **the hook allows the tool to proceed.** This ensures Relay never breaks the developer's workflow. A missed lock is recoverable; a frozen agent is not.

```javascript
// Every hook wraps its main() in a catch-all
main().catch(() => {
  respond_allow();  // ALWAYS fail open
});
```

---

## 5C. Quick Reference — All Agents Side by Side

| Property | Claude Code | Cursor | Codex CLI | Copilot CLI | Antigravity |
|----------|-------------|--------|-----------|-------------|-------------|
| **Config file** | `.claude/settings.json` | `.cursor/hooks.json` | `.codex/hooks.json` | `.github/hooks/*.json` | `.agents/hooks.json` |
| **Event name** | `PreToolUse` | `preToolUse` | `PreToolUse` | `preToolUse` | `PreToolUse` |
| **Stop event** | `Stop` | `stop` | `Stop` | `agentStop` | `Stop` |
| **Matcher format** | Pipe-delimited | Pipe-delimited | Pipe-delimited | Pipe-delimited | Regex |
| **Tool names** | `Edit\|Write\|Replace` | `Write\|Edit\|str_replace_based_edit_tool` | `Edit\|Write\|Replace` | `edit_file\|write_file` | `.*write_to_file.*` etc. |
| **Command field** | `command` | `command` | `command` | `bash` + `powershell` | `command` |
| **Allow response** | `{ "continue": true }` | `{ "permission": "allow" }` | `{ "continue": true }` | `{ "behavior": "allow" }` | `{ hookSpecificOutput: { permissionDecision: "allow" } }` |
| **Deny response** | `exit(2)` + stderr | `{ "permission": "deny" }` | `exit(2)` or JSON | `exit(2)` / fail-closed | `{ hookSpecificOutput: { permissionDecision: "deny" } }` |
| **File path field** | `tool_input.file_path` | `tool_input.target_file` | `tool_input.file_path` | `tool_input.file_path` | `TargetFile` or `toolCall.args.TargetFile` |
| **Session ID field** | `session_id` | `conversation_id` | `session_id` | `session_id` | `SESSION_ID` env var |
| **Prerequisite** | None | None | `config.toml` feature flag | None | None |

---

# Part II — System Architecture

---

## 6. Backend Coordinator Service

> **Analogy — The Air Traffic Control Tower:** Every airport has planes (agents) that want to use runways (files). The Coordinator is the ATC tower — it maintains the global view of which runways are occupied, clears planes for takeoff, and tells others to hold. Without it, you get collisions. With it, you get parallel throughput.

### 6A. What the Coordinator Is

The Coordinator is a lightweight **Express.js HTTP server** that runs locally (bound to `127.0.0.1`) as a background daemon. It is the authoritative source of truth for the **Lock Table** — the in-memory map of which files are currently locked by which agents.

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Backend Coordinator Service                       │
│                   (Node.js + Express)                               │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │  Lock Table   │  │  SSE Stream  │  │  Disk Persistence        │ │
│  │  (in-memory   │  │  (real-time  │  │  (.relay/locks/*.lock)   │ │
│  │   Map<K,V>)   │  │   pub/sub)   │  │  (coordinator-state.json)│ │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘ │
│                                                                     │
│  Binds to: 127.0.0.1:<dynamic-port>                                │
│  State file: .relay/coordinator-state.json { port, startedAt }     │
│  Log file: .relay/coordinator.log (auto-rotated at 5MB)            │
└─────────────────────────────────────────────────────────────────────┘
```

### 6B. Deployment Options

| Mode | How | Best for |
|------|-----|----------|
| **Auto-daemon** (default) | `relay init` spawns the coordinator as a detached child process. Port is written to `.relay/coordinator-state.json`. | Solo developer, single machine |
| **Manual** | `node backend/coordinator/server.js <workspacePath> --port 9100` | CI/CD pipelines, controlled environments |
| **Docker** | `docker run -v /repo:/workspace relay-coordinator /workspace` | Team deployment, multi-user setups |
| **Cloud-hosted** | Deploy as a standard Node.js service (e.g., Cloud Run, Railway, Fly.io) with workspace path mounted or provided via env var | Distributed teams across machines |

**Port binding strategy:**
1. Try the preferred port (from `--port` flag or last known port in `coordinator-state.json`)
2. If `EADDRINUSE`, fall back to port `0` (OS-assigned ephemeral port)
3. Write actual port to `.relay/coordinator-state.json` — all clients read from here

### 6C. API Routes

The Coordinator exposes a minimal, purpose-built REST API:

| Method | Route | Purpose | Request Body | Response |
|--------|-------|---------|-------------|----------|
| `GET` | `/health` | Liveness check | — | `{ ok, port, uptime, workspacePath }` |
| `POST` | `/claim` | Acquire a file lock | `{ agentId, file, ttl? }` | `{ allowed: true }` or `{ allowed: false, holder, reason }` |
| `POST` | `/release` | Release a single file lock | `{ agentId, file }` | `{ ok: true }` |
| `POST` | `/release-all` | Release ALL locks for an agent (on shutdown) | `{ agentId }` | `{ released: [filePaths...] }` |
| `GET` | `/status` | Full lock table snapshot | — | `{ locks: { [filePath]: { agentId, claimedAt, ttlMs, expiresAt } }, uptime }` |
| `GET` | `/stream` | SSE event stream (real-time lock updates) | — | Server-Sent Events, one event per lock change |

### 6D. The Lock Table — Internals

The `LockTable` class (`backend/coordinator/lockTable.js`) is an `EventEmitter`-backed in-memory `Map` with disk persistence:

```javascript
class LockTable extends EventEmitter {
  locks: Map<filePath, {
    filePath: string,       // Normalized relative path
    agentId: string,        // "AgentLabel:machineId:sessionId"
    claimedAt: number,      // Unix timestamp (ms)
    ttlMs: number           // Time-to-live in milliseconds
  }>
}
```

**Lock lifecycle:**

```
  claim(agentId, file, ttl)
         │
         ▼
  ┌──────────────────┐     YES     ┌──────────────┐
  │ Lock exists for  │────────────►│ Same agent?  │
  │ this file?       │             └──────┬───────┘
  └────────┬─────────┘               YES  │  NO
           │ NO                           │   │
           ▼                              ▼   ▼
    ┌──────────────┐              ┌─────────┐ ┌──────────────────┐
    │ GRANT lock   │              │ RENEW   │ │ Is lock expired? │
    │ Write to Map │              │ (reset  │ └────────┬─────────┘
    │ Write to disk│              │  TTL)   │      YES │   NO
    │ emit('change')              └─────────┘          ▼    ▼
    └──────────────┘                          ┌──────┐ ┌────────┐
                                              │GRANT │ │ DENY   │
                                              │(take │ │{holder}│
                                              │ over)│ └────────┘
                                              └──────┘
```

**TTL configuration:**
- Default: `90,000ms` (90 seconds)
- Minimum: `5,000ms` (5 seconds)
- Maximum: `300,000ms` (5 minutes)
- Cleanup interval: `30,000ms` (every 30 seconds, a sweep deletes expired locks)

**Dual-write persistence:** Every lock is simultaneously written to memory (`Map`) AND to disk (`.relay/locks/<hash>.lock`). This means if the coordinator crashes, locks survive on disk and are reloaded on restart.

### 6E. The Client — Fallback Chain

The coordinator client (`backend/coordinator/client.js`) implements a **three-tier fallback chain** to guarantee that hooks never hang, even if the coordinator is down:

```
  Hook calls claimFile()
         │
         ▼
  ┌──────────────────────────┐
  │ Tier 1: HTTP Coordinator │  POST /claim to 127.0.0.1:<port>
  │ Timeout: 2000ms          │  Read port from coordinator-state.json
  └──────────┬───────────────┘
             │ FAIL (ECONNREFUSED, timeout, no state file)
             ▼
  ┌──────────────────────────┐
  │ Tier 2: Filesystem       │  Exclusive lockfile creation (wx flag)
  │ Timeout: remaining ms    │  .relay/locks/<hash>.lock
  │ (total budget: 3000ms)   │  Check owner + TTL if file exists
  └──────────┬───────────────┘
             │ FAIL (FS error, timeout)
             ▼
  ┌──────────────────────────┐
  │ Tier 3: Fail Open        │  Return { allowed: true, source: 'fail-open' }
  │ (no locking enforced)    │  Log warning: COORDINATOR_UNAVAILABLE
  └──────────────────────────┘
```

**Total timeout budget:** `3,000ms` — guaranteed. The hook will ALWAYS respond within 3 seconds, regardless of what goes wrong.

### 6F. SSE Streaming — Real-Time UI Updates

The `/stream` endpoint provides **Server-Sent Events** for real-time lock visualization in Mission Control:

```javascript
// Coordinator server
app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send current state immediately
  res.write(`data: ${JSON.stringify(lockTable.status())}\n\n`);

  // Push on every lock change
  const listener = () => res.write(`data: ${JSON.stringify(lockTable.status())}\n\n`);
  lockTable.on('change', listener);
  req.on('close', () => lockTable.off('change', listener));
});
```

The Mission Control UI (`FileLocksPanel.tsx`) connects to this stream via `EventSource` and renders lock state changes instantly — no polling required.

---

## 7. Backend API Server (The Orchestrator)

> The Backend API Server is a **separate** Express app from the Coordinator. The Coordinator handles locks only. The Backend API Server handles everything else — project management, memory, sync, dashboard data, and serves the frontend UI.

### 7A. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│                    Backend API Server                                  │
│                    (backend/server.js — Express)                       │
│                                                                       │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ Project     │  │ Memory &     │  │ Agent        │  │ Static    │ │
│  │ Registry    │  │ Sync Engine  │  │ Handshake    │  │ Frontend  │ │
│  │             │  │              │  │ & Connect    │  │ Server    │ │
│  │ CRUD ops    │  │ relay sync   │  │              │  │           │ │
│  │ API keys    │  │ relay compile│  │ Per-agent    │  │ Serves    │ │
│  │ workspace   │  │ relay context│  │ token flow   │  │ MC UI     │ │
│  │ resolution  │  │ file watcher │  │              │  │           │ │
│  └─────────────┘  └──────────────┘  └──────────────┘  └───────────┘ │
│                                                                       │
│  ┌─────────────────────┐  ┌────────────────────────────────────────┐ │
│  │ Coordinator Client  │  │ Dashboard Builder                      │ │
│  │ (proxies lock API   │  │ (aggregates memory, timeline, IR,     │ │
│  │  for the frontend)  │  │  code edits, stats for the frontend)  │ │
│  └─────────────────────┘  └────────────────────────────────────────┘ │
│                                                                       │
│  Default port: 3001                                                   │
│  Serves static UI from: basic_frontend/ or mission-control/.next/    │
└───────────────────────────────────────────────────────────────────────┘
```

### 7B. Full API Surface

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/health` | Server liveness + version + auth status |
| `GET` | `/api/projects` | List all registered Relay projects |
| `POST` | `/api/projects` | Register a new workspace as a project |
| `GET` | `/api/projects/:id` | Get project details (including API key) |
| `PATCH` | `/api/projects/:id` | Update project name |
| `POST` | `/api/projects/:id/sync` | Trigger full sync for a project |
| `GET` | `/api/projects/:id/dashboard` | Get aggregated dashboard data (timeline, IR, stats, code edits) |
| `POST` | `/api/register` | Register a workspace (legacy route) |
| `POST` | `/api/handshake` | Send handshake token to a specific agent |
| `POST` | `/api/connect` | Connect an agent (handshake + watcher start) |
| `POST` | `/api/sync` | Trigger sync by workspacePath |
| `GET` | `/api/memory` | Get raw `memory.json` for a workspace |
| `GET` | `/api/locks` | Get current lock status (proxies to Coordinator) |
| `GET` | `/api/locks/stream` | SSE stream of lock changes (proxies to Coordinator `/stream`) |
| `GET` | `/api/relay-files` | List all `.relay/` IR files |
| `GET` | `/api/relay-file` | Read a specific `.relay/*.md` file |
| `PUT` | `/api/relay-file` | Write/update a `.relay/*.md` file |
| `GET` | `/api/context` | Get the latest `relay_context.md` |
| `GET` | `/api/compile-brief` | Get the latest `compile_brief.md` |
| `GET` | `/` | Serve the Mission Control frontend |

### 7C. Deployment

| Mode | Command | Notes |
|------|---------|-------|
| **Local dev** | `relay serve` or `node backend/server.js --port 3001` | Starts both the API server and auto-launches the Coordinator daemon |
| **Docker** | See below | Bundles API server + Coordinator + frontend in one container |
| **Cloud** | Deploy to any Node.js hosting (Render, Railway, Fly.io, Cloud Run) | Mount workspace via volume or use the Central API for remote sync |

**Docker deployment:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3001
ENV RELAY_PORT=3001
CMD ["node", "backend/server.js", "--port", "3001"]
```

```bash
docker build -t relay-server .
docker run -d \
  -p 3001:3001 \
  -v /path/to/repos:/workspaces \
  --name relay \
  relay-server
```

---

## 8. Mission Control — The Dashboard UI

> **Analogy — NASA Mission Control:** Just like NASA has a room full of screens showing every satellite, every trajectory, and every system status in real time — Relay's Mission Control gives you a single screen showing every agent, every file lock, every code edit, and every conversation happening across your project.

### 8A. Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | **Next.js 14+** (App Router) |
| Language | **TypeScript** |
| Styling | **CSS Modules** (per-component `.module.css`) |
| State | **React Context** (`RelayContext`) + hooks |
| Data fetching | REST API calls to Backend API Server + SSE for real-time locks |
| Real-time | `EventSource` (SSE) for live lock updates |

### 8B. Component Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Mission Control UI                            │
│                                                                      │
│  ┌──────────────┐  ┌─────────────────────────────────────────────┐  │
│  │ WorkspaceRail│  │              Main Content Area              │  │
│  │              │  │                                             │  │
│  │ • Project    │  │  ┌─────────────────────────────────────┐   │  │
│  │   selector   │  │  │         GlobalHeader                │   │  │
│  │ • Add new    │  │  │  Project name + Sync button         │   │  │
│  │   workspace  │  │  └─────────────────────────────────────┘   │  │
│  │              │  │                                             │  │
│  └──────────────┘  │  ┌─────────────────────────────────────┐   │  │
│                     │  │       ProjectDashboard (tabbed)     │   │  │
│  ┌──────────────┐  │  │                                     │   │  │
│  │   Sidebar    │  │  │  Tabs:                              │   │  │
│  │              │  │  │  ┌─────────┬──────────┬──────────┐  │   │  │
│  │ • Agent      │  │  │  │Activity │Agent Chat│Code Edits│  │   │  │
│  │   Integrations  │  │  ├─────────┼──────────┼──────────┤  │   │  │
│  │   (connect   │  │  │  │Coordin- │ Team     │ All IR   │  │   │  │
│  │   per agent) │  │  │  │ator     │ Activity │ Files    │  │   │  │
│  │              │  │  │  │(Locks)  │          │          │  │   │  │
│  │ • Recent     │  │  │  ├─────────┴──────────┴──────────┤  │   │  │
│  │   Activity   │  │  │  │         Settings              │  │   │  │
│  │   Feed       │  │  │  └───────────────────────────────┘  │   │  │
│  │              │  │  │                                     │   │  │
│  └──────────────┘  │  └─────────────────────────────────────┘   │  │
│                     │                                             │  │
│                     └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 8C. UI Panels — What Each One Does

#### 1. Activity Timeline (`ActivityTimeline.tsx`)
- **What:** Chronological feed of every agent event — user prompts, assistant responses, code edits, artifacts.
- **How:** Reads from `memory.json` timeline. Groups events into **segments** by agent and conversation turn (splits at user message boundaries).
- **Visual:** Each segment shows agent logo, label, timestamp, and expandable event list. Code edits show file paths; messages show content previews.

#### 2. Agent Session Chat (`AgentSessionChat.tsx`)
- **What:** Full chat transcript viewer — see the exact conversation between the user and each AI agent.
- **How:** Pulls session transcripts from extracted IDE chat logs. Renders user messages, assistant messages, tool calls, and tool results in a chat-bubble UI.
- **Cross-agent visibility:** You can see what Claude discussed, what Cursor generated, and what Codex explored — all from one unified view.

#### 3. Code Edits (`ProjectDashboard.tsx` → `EditCard`)
- **What:** Every file modification made by any agent, shown as expandable diff cards.
- **Visual:** Each card shows the agent logo, file path, timestamp, and an expandable unified diff (capped at 80 lines with truncation).

#### 4. Coordinator / File Locks (`FileLocksPanel.tsx`)
- **What:** Real-time view of the Lock Table — which files are locked, by which agent, since when.
- **How:** Connects to the Backend API's `/api/locks/stream` SSE endpoint. Renders lock status instantly as changes occur.
- **Sections:**
  - **Active Agent Sessions** — lists all connected agent instances with logos, session IDs, and last-active timestamps.
  - **Real-time File Locks** — shows each locked file with the holder agent, session short-ID, and claim time. Lock source (coordinator vs. disk fallback) is displayed.
- **Agent ID resolution:** Parses the `AgentLabel:machineId:sessionId` format to display human-readable agent names and logos.

#### 5. Team Activity (`TeamPanel.tsx`)
- **What:** Multi-user collaboration view — see what other team members' agents are doing.
- **How:** Aggregates events from the Central API or shared `memory.json` across users.

#### 6. All IR Files / Memory (`ProjectDashboard.tsx` → Memory tab)
- **What:** Browse all Relay Intermediate Representation (IR) markdown files.
- **Sub-tabs:** `Project` | `Tasks` | `Decisions` | `Failures` | `Architecture` | `Compile Brief`
- **Layout:** Split view — Handoff context on the left, selected IR file on the right.
- **Purpose:** Gives you a bird's-eye view of the shared AI memory — what the agents collectively know about your project.

#### 7. Settings (`ProjectDashboard.tsx` → Settings tab)
- **What:** Project metadata, API key management, usage stats.
- **Shows:** Project name, workspace path, API key (for MCP/remote agents), total events count, connected agents count, last sync timestamp.

### 8D. Sidebar — Agent Integrations Panel (`Sidebar.tsx`)

The sidebar is the **control panel for connecting agents** to Relay:

```
  ┌─────────────────────────────┐
  │  AGENT INTEGRATIONS          │
  │                              │
  │  [🟢 Claude Code  Connected]│  ← Click to handshake
  │  [🟡 Cursor     Connecting…]│  ← Handshake in progress
  │  [⚪ Codex        Connect  ]│  ← Not yet connected
  │  [⚪ Copilot      Connect  ]│
  │  [🟢 Antigravity Connected]│
  │                              │
  │  RECENT AGENT ACTIVITY       │
  │                              │
  │  ✎ Claude: Edited auth.ts    │  ← 2s ago
  │  • Cursor: Analyzed deps     │  ← 15s ago
  │  ◆ Antigravity: Created plan │  ← 1m ago
  └─────────────────────────────┘
```

**Connection flow:**
1. Click an agent's "Connect" button → `POST /api/handshake` → writes a `.relay/.handshake_<agent>` token file.
2. The agent's next tool call reads the handshake → confirms connection → status turns green.
3. `POST /api/connect` → starts file watcher → events begin flowing into the timeline.
4. Status states: `idle` → `handshaking` → `connected` (or `error` with retry).

### 8E. Data Flow — End to End

```
Agent makes an edit
       │
       ▼
Pre-tool hook fires → Coordinator claims lock
       │
       ▼
Edit happens → File saved to disk
       │
       ▼
relay watch (file watcher) detects change → Writes to memory.json timeline
       │
       ▼
Backend API Server reads memory.json → Builds dashboard payload
       │
       ▼
Mission Control fetches /api/projects/:id/dashboard → Renders UI
       │
       ▼ (simultaneously)
SSE /api/locks/stream → FileLocksPanel updates in real-time
```

### 8F. The Two Servers — Why They're Separate

| Concern | Coordinator | Backend API Server |
|---------|-------------|--------------------|
| **Purpose** | File locking only | Everything else |
| **Lifecycle** | Auto-started as daemon, can crash/restart independently | Started explicitly by `relay serve` |
| **Port** | Dynamic (ephemeral) | Fixed (default `3001`) |
| **Consumers** | Hook scripts only (via `client.js`) | Mission Control UI, CLI commands |
| **State** | Lock table (transient, TTL-based) | Memory.json, IR files, project registry (persistent) |
| **Failure mode** | If down → hooks fall back to filesystem locking | If down → UI unavailable, but agents still work |

> **Why not merge them?** The Coordinator must be ultra-lightweight and always running (hooks call it on every tool invocation). The Backend API Server is heavier (dashboard rendering, file parsing, memory aggregation) and only needs to run when someone is viewing the UI. Keeping them separate means a Coordinator crash doesn't take down the UI, and vice versa.

---

# Part III — Performance, MCP, & Patch Coordination

---

## 9. Event-Driven Architecture — Why Relay Never Busy-Waits

> **The cardinal sin of coordination tools is polling.** If your lock-check is a `while(!available) { sleep(100); }` loop, you've already lost. Every 100ms of sleep is 100ms of wasted CPU, 100ms of latency, and 100ms of frustration. Relay is designed from the ground up to be **fully event-driven** — nothing polls, nothing spins, nothing busy-waits.

### 9A. The Problem with Polling

In a naive coordination system, a blocked agent would do this:

```
❌ BAD — Polling (busy-wait)
while (true) {
  const result = await checkLock(file);
  if (result.available) break;
  await sleep(500);  // 🚨 Wasting CPU cycles, adding 500ms latency
}
```

This is catastrophic at scale:
- **5 agents × 10 tools/minute × 500ms poll interval** = permanent CPU churn
- Latency floor of 250ms (average half-interval) on every lock acquisition
- Thundering herd: all agents wake up simultaneously on each interval

### 9B. Relay's Event-Driven Design

Relay eliminates polling at every layer with three interlocking mechanisms:

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Event-Driven Stack                                  │
│                                                                     │
│  Layer 1: LockTable (EventEmitter)                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  this.emit('change') ──► all listeners fire instantly       │   │
│  │  No polling. No timers. Pure event propagation.             │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  Layer 2: SSE Push (Server-Sent Events)                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  lockTable.on('change') ──► res.write(SSE data)             │   │
│  │  Push-based. No client polling. Instant UI updates.         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│  Layer 3: Hook Protocol (Fire-and-Respond)                          │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Hook fires ──► single HTTP call ──► immediate response     │   │
│  │  No retry loop. No wait queue. Fail-open in 3s max.         │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer 1 — LockTable as EventEmitter

The `LockTable` class extends Node.js `EventEmitter`. Every mutation (claim, release, TTL expiry) calls `this.emit('change')`:

```javascript
class LockTable extends EventEmitter {
  claim(agentId, filePath, ttl) {
    // ... grant or deny logic ...
    this.locks.set(filePath, lockInfo);
    this.emit('change');  // 🔔 Instant notification to all listeners
    return { allowed: true };
  }

  release(agentId, filePath) {
    this.locks.delete(filePath);
    this.emit('change');  // 🔔 Instant notification
    return { ok: true };
  }

  _cleanup() {
    // TTL sweep — runs on a 30s setInterval, BUT:
    // - The interval is .unref()'d (won't keep process alive)
    // - Only emits 'change' if something actually expired
    // - No agent is waiting on this — it's background hygiene
    let changed = false;
    for (const [filePath, lock] of this.locks) {
      if (Date.now() - lock.claimedAt >= lock.ttlMs) {
        this.locks.delete(filePath);
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }
}
```

**Why this matters:** The SSE `/stream` endpoint doesn't poll the lock table on a timer. It registers a listener on `'change'` and is woken up *only when something actually changes*. Zero CPU when idle.

### Layer 2 — SSE Push (Zero-Poll UI Updates)

The Mission Control frontend uses `EventSource` — a browser-native push channel:

```
  Coordinator                         Browser (Mission Control)
  ─────────────────────────────────────────────────────────────
  lockTable.on('change', () => {
    res.write(SSE data)  ─────────►  EventSource.onmessage
  })                                  → setState(newLocks)
                                      → UI re-renders
  
  ❌ NOT: setInterval(() => fetch('/status'), 1000)
  ✅ YES: Push on change. Zero traffic when idle.
```

**Idle cost:** When no agents are editing anything, the SSE connection is open but silent. Zero bytes on the wire. Zero CPU. The moment a lock changes, the update arrives in **sub-millisecond** latency (localhost loopback).

### Layer 3 — Hook Protocol (Fire-and-Respond, Never Wait)

Pre-tool hooks are **synchronous gatekeepers** — they fire, decide, and return. There is no "wait for lock to become available" mode:

```
Agent wants to edit file
       │
       ▼
  Hook fires (process spawned)
       │
       ▼
  Single HTTP POST /claim ──► Coordinator responds immediately
       │                       (Map.get + Map.set = O(1))
       │
       ├── ALLOWED → Hook exits 0 → Agent proceeds
       │
       └── DENIED → Hook exits with deny response
                     → Agent receives reason string
                     → Agent PICKS A DIFFERENT TASK
                     → No waiting, no retry loop
```

**Critical insight:** The agent doesn't wait for the lock to free up. It receives a structured denial reason like *"File locked by Cursor (session abc). Pick a different task."* and the AI agent's reasoning engine decides what to work on instead. This turns a blocking problem into a routing problem — the AI routes itself to unlocked work.

### 9C. Timing Budget — End to End

| Step | Mechanism | Worst-case latency |
|------|-----------|-------------------|
| Hook process spawn | OS fork | ~50ms |
| stdin JSON parse | `JSON.parse()` | <1ms |
| Coordinator HTTP POST `/claim` | Express route → `Map.get()` → `Map.set()` | ~5ms |
| Response write to stdout | `process.stdout.write()` | <1ms |
| **Total (Coordinator up)** | | **~60ms** |
| Filesystem fallback | `fs.open(path, 'wx')` | ~10ms |
| **Total (Coordinator down)** | | **~70ms** |
| Fail-open (everything broken) | Immediate return | **<1ms** |

**Guaranteed budget:** The `TOTAL_TIMEOUT` cap is 3,000ms. In practice, hooks complete in **50–70ms**. The 3s cap is for catastrophic edge cases only.

### 9D. The Only Timer — TTL Cleanup

There is exactly **one** `setInterval` in the entire system:

```javascript
this._cleanupTimer = setInterval(() => this._cleanup(), 30_000);
this._cleanupTimer.unref();  // Won't prevent process exit
```

This sweep runs every 30 seconds to delete expired locks. It is:
- **Not on the critical path** — no agent waits for it
- **Unref'd** — won't keep the coordinator alive if nothing else is running
- **Lazy** — only emits `'change'` if it actually found and deleted expired locks
- **The only concession** — pure event-driven systems can't do TTL without a timer

---

## 10. Relay MCP Server — Structured Tool Access

> **Hooks are interceptors. The MCP server is a collaborator.** Hooks run invisibly before every tool call. The MCP server gives agents *explicit tools* they can call when they want to interact with Relay — check locks, read shared memory, report changes, coordinate with teammates.

### 10A. What Is MCP?

**Model Context Protocol (MCP)** is an open standard that lets AI agents call external tools via structured JSON-RPC 2.0 messages over **stdio** (stdin/stdout pipes). It's how agents like Claude Code, Cursor, Codex, and Antigravity talk to external services without requiring HTTP.

```
Agent Process                MCP Server Process
─────────────               ──────────────────
                  stdin (JSON-RPC)
  tools/list    ──────────────►   { tools: [...] }
                  stdout (JSON-RPC)
                ◄──────────────   

                  stdin
  tools/call    ──────────────►   callTool(name, args)
  { name: "relay_claim_file",       │
    args: { file: "src/app.ts" }}    ▼
                                  coordinator.claimFile()
                  stdout              │
                ◄──────────────   { content: "Lock granted" }
```

### 10B. Transport — stdio, Not HTTP

The Relay MCP server uses **stdio transport** (JSON-RPC over newline-delimited stdin/stdout), NOT an HTTP server:

```javascript
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const req = JSON.parse(line.trim());
  handleRequest(req);  // Dispatches to tool handlers
});

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
```

**Why stdio over HTTP?**
- **No port conflicts** — stdio doesn't bind to any port
- **Process lifecycle** — the MCP server lives and dies with the agent
- **Zero network overhead** — pipe-based IPC, no TCP handshake
- **Security** — no open ports to scan, no auth needed
- **Standard** — every MCP-compatible agent already speaks stdio

### 10C. Dual Mode — Local & Remote

The MCP server operates in two modes, selected by environment variables:

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Server Modes                              │
│                                                                 │
│  LOCAL MODE (default)                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  RELAY_WORKSPACE_PATH=/path/to/repo                      │  │
│  │                                                          │  │
│  │  relay_read_file ──► fs.readFile(.relay/project.md)      │  │
│  │  relay_claim_file ──► coordinator client (HTTP/fallback) │  │
│  │  relay_sync ──► syncWorkspace() (direct function call)   │  │
│  │                                                          │  │
│  │  Everything runs locally. No network. Fast.              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  REMOTE MODE                                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  RELAY_API_URL=https://relay.example.com                 │  │
│  │  RELAY_API_KEY=sk-relay-...                              │  │
│  │                                                          │  │
│  │  relay_read_file ──► GET /api/relay/file?path=...        │  │
│  │  relay_claim_file ──► POST /api/locks/claim (remote)     │  │
│  │  relay_sync ──► POST /api/sync (remote)                  │  │
│  │                                                          │  │
│  │  For cloud agents, CI, or distributed teams.             │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 10D. Tool Catalog — All 14 Tools

#### Local Tools (work in both modes)

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `relay_list_files` | List files/folders inside `.relay/` | `path` (relative, `""` for root) |
| `relay_read_file` | Read any `.relay/` file (markdown, JSON) | `path` (e.g. `"relay_context.md"`) |
| `relay_write_file` | Write/update a `.relay/` IR file | `path`, `content` |
| `relay_get_context` | Regenerate and return `relay_context.md` handoff | — |
| `relay_sync` | Sync agent transcripts → `memory.json` → compile brief | — |

#### Coordination Tools (file locking)

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `relay_claim_file` | Acquire exclusive write lock before editing | `file` (repo-relative), `ttl_ms` (optional) |
| `relay_release_file` | Release a lock after editing | `file` |
| `relay_status` | View full lock table (all held locks + expiry) | — |

#### Central Relay Tools (multi-user collaboration)

| Tool | Purpose | Key Arguments |
|------|---------|---------------|
| `relay_report_change` | Report a code change to Central for team visibility | `file`, `content` (summary) |
| `relay_get_project_context` | Pull compiled team context from Central | — |
| `relay_get_recent_changes` | Pull latest `changes.md` from Central | — |
| `relay_get_decisions` | Pull team `decisions.md` from Central | — |
| `relay_get_active_tasks` | Pull team `tasks.md` from Central | — |
| `relay_report_decision` | Report an open/resolved decision | `decision_id`, `decision`, `status` |
| `relay_update_task` | Create or update a task status | `task_id`, `description`, `status` |

### 10E. MCP vs Hooks — When to Use Which

| Dimension | Pre-Tool Hooks | MCP Server |
|-----------|---------------|------------|
| **Trigger** | Automatic (every file-write tool call) | Explicit (agent chooses to call) |
| **Visibility** | Invisible to the agent | Visible — agent sees tool in its tool list |
| **Purpose** | Enforcement (lock before every write) | Exploration (read context, report changes) |
| **Blocking** | Can deny tool execution | Cannot block anything |
| **Install** | Config files per agent | Single `mcpServers` config entry |
| **Transport** | Process spawn (child_process) | stdio (JSON-RPC over pipe) |
| **When needed** | Always — non-negotiable for coordination | Optional — for agents that want richer Relay interaction |

> **Use both together.** Hooks enforce coordination silently. MCP tools give agents the ability to *think* about coordination — check what's locked, read what other agents did, report their own work to the team.

### 10F. MCP Server Configuration — Per Agent

**Claude Code** (`~/.claude/settings.json` or project `.claude/settings.json`):
```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["<path-to-relay>/backend/mcp/server.js"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/path/to/repo"
      }
    }
  }
}
```

**Cursor** (Settings → MCP → Add Server):
```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["<path-to-relay>/backend/mcp/server.js"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/path/to/repo"
      }
    }
  }
}
```

**Antigravity** (`.agents/mcp_config.json`):
```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["<path-to-relay>/backend/mcp/server.js"],
      "env": {
        "RELAY_WORKSPACE_PATH": "/path/to/repo"
      }
    }
  }
}
```

---

## 11. Patch Coordination & Central Sync Pipeline

> **The problem:** Five agents across two users are making rapid edits. Changes need to flow between them in near-real-time, but we can't git-push-pull on every keystroke. We need an event-driven pipeline that detects changes, deduplicates, delivers patches, and flags conflicts — all without blocking anyone.

### 11A. The Event Pipeline — End to End

```
  Agent A edits file
       │
       ▼
  ┌──────────────────────────────────────────┐
  │  1. Pre-Tool Hook                        │
  │     → claimFile() → lock acquired        │
  └──────────────────────┬───────────────────┘
                         │
  ┌──────────────────────▼───────────────────┐
  │  2. File Watcher (relay watch)           │
  │     → Detects FS change event            │
  │     → Extracts diff (git diff HEAD)      │
  │     → Appends to memory.json timeline    │
  │     → Emits 'fileChange' event           │
  └──────────────────────┬───────────────────┘
                         │
  ┌──────────────────────▼───────────────────┐
  │  3. Sync Bridge (centralSync.js)         │
  │     → Pushes code_edit events to Central │
  │     → Deterministic dedup (SHA-256 hash) │
  │     → Cursor tracking (lastPushedEventTs)│
  └──────────────────────┬───────────────────┘
                         │
  ┌──────────────────────▼───────────────────┐
  │  4. Central Relay API                    │
  │     → Stores event in central store      │
  │     → Compiles central context           │
  │     → Available to all team members      │
  └──────────────────────┬───────────────────┘
                         │
  ┌──────────────────────▼───────────────────┐
  │  5. Pull (other users)                   │
  │     → pullCentralChanges()               │
  │     → Appends to local central_events.jsonl│
  │     → Conflict detection on overlap      │
  └──────────────────────────────────────────┘
```

### 11B. Conflict Detection Engine

The conflict detection module (`relayConflicts.js`) scans for **overlapping edits** — different agents editing the same file within a configurable time window:

```javascript
function detectConflicts(memory, windowMs = 5 * 60 * 1000) {
  // Scan all agents' code_edit events from the last 5 minutes
  // Group by normalized file path
  // Flag any file edited by 2+ distinct agents

  return [{
    file: "src/auth.ts",           // The contested file
    agents: ["Claude Code", "Cursor"],  // Who touched it
    edits: [
      { agent: "Claude Code", ts: "2025-08-15T14:30:00Z", summary: "Added JWT verify" },
      { agent: "Cursor",      ts: "2025-08-15T14:31:22Z", summary: "Refactored auth flow" }
    ]
  }];
}
```

**How it works:**
1. **Time window:** Default 5 minutes. Only edits within this window are considered.
2. **Path normalization:** Lowercased, forward slashes, no trailing slash — `C:\Users\unnat\src\App.ts` and `src/app.ts` are treated as the same file.
3. **Agent deduplication:** The same agent editing the same file multiple times is NOT a conflict. Only cross-agent overlaps count.
4. **Surfacing:** Conflicts are displayed in Mission Control's dashboard and included in `compile_brief.md` so agents are aware of them.

### 11C. Push/Pull Sync — Idempotent & Ordered

The Central Sync Bridge (`centralSync.js`) ensures events flow between machines without duplication:

**Push (local → central):**
```
  memory.json timeline
       │
       ▼
  Filter: only code_edit events
       │
       ▼
  Cursor check: skip events before lastPushedEventTs
       │
       ▼
  For each new event:
    1. Generate deterministic client_event_id:
       SHA-256(timestamp + filepath + index)  ← Idempotent! Re-pushing is safe.
    2. POST to Central API: /api/central/projects/:id/events
    3. On success: advance cursor (lastPushedEventTs)
    4. On failure: STOP pushing (fail-open, resume next sync)
```

**Pull (central → local):**
```
  GET /api/central/projects/:id/events?after=lastPulledId
       │
       ▼
  Append new events to .relay/central_events.jsonl
       │
       ▼
  Advance cursor: lastPulledCentralEventId = latest event ID
       │
       ▼
  Compile central context → central_context.md
       │
       ▼
  Available to all local agents via MCP tools or relay_context.md
```

**Idempotency guarantee:** The `client_event_id` is a SHA-256 of `(timestamp, filepath, index)`. If the same event is pushed twice (network retry, duplicate sync), the Central API deduplicates by this ID. No double-counting.

### 11D. The Unified Backend — How It All Fits Together

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       UNIFIED RELAY BACKEND                             │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │  Express API Server (backend/server.js)          Port: 3001       │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │ │
│  │  │ Project  │ │ Memory   │ │ Dashboard│ │ Central  │            │ │
│  │  │ Registry │ │ & Sync   │ │ Builder  │ │ Sync     │            │ │
│  │  │          │ │          │ │          │ │ Bridge   │            │ │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘            │ │
│  │       │             │             │             │                  │ │
│  │       ▼             ▼             ▼             ▼                  │ │
│  │  ┌─────────────────────────────────────────────────────────────┐  │ │
│  │  │                  Static Frontend Server                     │  │ │
│  │  │                  (Mission Control UI)                       │  │ │
│  │  └─────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│                              │                                          │
│  ┌───────────────────────────▼───────────────────────────────────────┐ │
│  │  Coordinator Daemon (coordinator/server.js)    Port: ephemeral   │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                         │ │
│  │  │ LockTable│ │ SSE      │ │ Disk     │                         │ │
│  │  │(EventEmit│ │ /stream  │ │ Persist  │                         │ │
│  │  │ ter)     │ │ (push)   │ │ (*.lock) │                         │ │
│  │  └──────────┘ └──────────┘ └──────────┘                         │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                              │                                          │
│  ┌───────────────────────────▼───────────────────────────────────────┐ │
│  │  MCP Server (mcp/server.js)                    Transport: stdio  │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                         │ │
│  │  │ Local    │ │ Lock     │ │ Central  │                         │ │
│  │  │ Tools    │ │ Tools    │ │ Tools    │                         │ │
│  │  │ (5)      │ │ (3)      │ │ (6)      │                         │ │
│  │  └──────────┘ └──────────┘ └──────────┘                         │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │  Pre-Tool Hooks (per-agent scripts)                              │ │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────────┐          │ │
│  │  │Claude│ │Cursor│ │Codex │ │Copil.│ │Antigravity   │          │ │
│  │  └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──────┬───────┘          │ │
│  │     └────────┴────────┴────────┴─────────────┘                   │ │
│  │                       │                                           │ │
│  │              relay-hook-lib.js (shared)                           │ │
│  │              coordinator/client.js (3-tier fallback)              │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### 11E. Performance Guarantees — Summary

| Operation | Mechanism | Latency | Blocks agent? |
|-----------|-----------|---------|---------------|
| File lock claim | HTTP POST → in-memory `Map.set()` | ~60ms | No (instant allow/deny) |
| File lock release | HTTP POST → `Map.delete()` | ~5ms | No |
| Lock status push to UI | SSE `EventEmitter.emit()` | <1ms | No |
| Hook total budget | 3-tier fallback with 3s hard cap | 50–70ms typical | No (fail-open) |
| Memory sync | File watcher → `memory.json` append | <100ms | No (async) |
| Central push | HTTP POST per event, cursor-tracked | 200–500ms/event | No (background) |
| Central pull | HTTP GET, append to JSONL | 200–500ms | No (background) |
| Conflict detection | In-memory scan of timeline | <10ms | No |
| TTL cleanup sweep | `setInterval` (30s), unref'd | N/A (background) | No |

> **Zero busy-waits. Zero polling loops. Zero blocked agents.** The entire system is event-driven from lock acquisition through UI rendering. The only timer is a 30-second background hygiene sweep that can't block anything.

---

## 12. The Central Relay — Inter-Machine Coordination

> **You spotted the gap.** The local Coordinator (Section 6) only handles **Intra** coordination — multiple agents on the **same machine** fighting over the same files. But what about Alice in New York running Claude Code and Bob in London running Cursor on the **same repo**? That's **Inter** coordination, and it requires a completely different architecture. The local Express server can't do this. You need a **shared, networked truth** — and that's the Central Relay.

### 12A. Two Layers, Two Problems, Two Solutions

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  INTRA (same machine)                INTER (across machines)             │
│  ─────────────────────               ───────────────────────             │
│                                                                          │
│  ┌──────────────────┐               ┌────────────────────────┐          │
│  │ Local Coordinator│               │   Central Relay API    │          │
│  │ (127.0.0.1:*)    │               │   (cloud-hosted or     │          │
│  │                  │               │    self-hosted server)  │          │
│  │ • File locks     │               │                        │          │
│  │ • TTL-based      │               │ • Event stream (JSONL) │          │
│  │ • In-memory Map  │               │ • Team changes/tasks   │          │
│  │ • SSE push       │               │ • Decisions log        │          │
│  │ • Ephemeral port │               │ • Conflict visibility  │          │
│  │ • 100% OFFLINE   │               │ • Auth (API keys)      │          │
│  └──────────────────┘               │ • Auto-compile context │          │
│  WHO:                               └────────────────────────┘          │
│  Claude, Cursor, Codex                                                   │
│  on YOUR laptop, fighting           WHO:                                 │
│  over YOUR files.                    Alice (NYC) + Bob (London)           │
│                                      + CI bot (cloud), all               │
│  HOW:                               working on the SAME repo.            │
│  Pre-tool hooks →                                                        │
│  HTTP POST /claim →                  HOW:                                │
│  instant allow/deny                  Push events → Central API →         │
│                                      Pull events → local context →       │
│  SPEED: ~60ms                        agents see team changes              │
│  FAIL: filesystem fallback                                               │
│  → fail-open                         SPEED: 200–500ms/event              │
│                                      FAIL: fail-open (local              │
│                                      agents keep working)                │
└──────────────────────────────────────────────────────────────────────────┘
```

### 12B. Central Relay Architecture

The Central Relay is a **second set of API routes** inside the same Express server (`backend/server.js`), but with a completely different auth model, data store, and purpose:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CENTRAL RELAY                                      │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  Auth Layer (centralAuth.js)                                    │   │
│  │                                                                 │   │
│  │  Bearer token → SHA-256 hash → match against project registry   │   │
│  │  Admin key: can create/list projects                            │   │
│  │  Project key: can only access its own project data              │   │
│  └────────────────────────────────┬────────────────────────────────┘   │
│                                   │                                     │
│  ┌────────────────────────────────▼────────────────────────────────┐   │
│  │  Project Registry (centralProjects.js)                          │   │
│  │                                                                 │   │
│  │  ~/.relay-os/central/central-projects.json                      │   │
│  │  [{ id, name, apiKeyHash, keyPrefix, createdAt }]               │   │
│  │                                                                 │   │
│  │  API key is returned ONCE on creation, then only the SHA-256    │   │
│  │  hash is stored. You can never retrieve the raw key again.      │   │
│  └────────────────────────────────┬────────────────────────────────┘   │
│                                   │                                     │
│  ┌────────────────────────────────▼────────────────────────────────┐   │
│  │  Event Store (centralStore.js)                                  │   │
│  │                                                                 │   │
│  │  ~/.relay-os/central/events/<projectId>.jsonl                   │   │
│  │                                                                 │   │
│  │  Append-only JSONL file. Each line is a JSON event.             │   │
│  │  Monotonic auto-increment event_id per project.                 │   │
│  │  Idempotent: duplicate client_event_id → skip.                  │   │
│  │  Serialized writes: in-memory promise queue per project.        │   │
│  └────────────────────────────────┬────────────────────────────────┘   │
│                                   │                                     │
│  ┌────────────────────────────────▼────────────────────────────────┐   │
│  │  Compiler (centralCompile.js)                                   │   │
│  │                                                                 │   │
│  │  Triggered after every event append.                            │   │
│  │  Reads ALL events → produces 5 markdown files:                  │   │
│  │    project.md, changes.md, decisions.md, tasks.md, agents.md    │   │
│  │                                                                 │   │
│  │  These are what agents read via relay_get_project_context.      │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 12C. Central API Routes

All Central routes live under `/api/central/` and require `Bearer <api-key>` authentication:

| Method | Route | Auth | Purpose |
|--------|-------|------|---------|
| `POST` | `/api/central/projects` | **Admin key only** | Create a new Central project. Returns API key **once**. |
| `GET` | `/api/central/projects` | **Admin key only** | List all Central projects |
| `GET` | `/api/central/projects/:id` | Project key | Get project metadata |
| `POST` | `/api/central/projects/:id/events` | Project key | Push an event (change, decision, task) |
| `GET` | `/api/central/projects/:id/events` | Project key | Pull events (with `?since=<eventId>&limit=&kind=` filters) |
| `GET` | `/api/central/projects/:id/context` | Project key | Get compiled context (all 5 markdown files joined) |
| `GET` | `/api/central/projects/:id/changes` | Project key | Get `changes.md` (recent code changes) |
| `GET` | `/api/central/projects/:id/decisions` | Project key | Get `decisions.md` (open/resolved decisions) |
| `GET` | `/api/central/projects/:id/tasks` | Project key | Get `tasks.md` (active task list) |

### 12D. The Event Store — Internals

The Event Store (`centralStore.js`) is the most performance-critical part of the Central Relay. Here's how it avoids busy-waiting and race conditions:

#### Promise Queue Serialization (No Busy-Wait)

```javascript
// In-memory state per project
const projectStates = new Map();
// Map<projectId, {
//   lastEventId: number,              // Monotonic counter
//   clientEventIds: Set<string>,      // Dedup set
//   queue: Promise<any>               // Serialization chain
// }>
```

Instead of locks or mutexes, the Central Store uses **promise chaining** — each write operation chains onto the previous one:

```javascript
async function appendEvent(projectId, event) {
  const state = await _getProjectState(projectId);

  // Chain this operation onto the queue — guarantees ordering
  state.queue = state.queue.then(async () => {
    // 1. Idempotency check (O(1) Set lookup)
    if (state.clientEventIds.has(event.client_event_id)) {
      return { ...event, ignoredAsDuplicate: true };  // Skip!
    }

    // 2. Monotonic ID assignment
    state.lastEventId += 1;
    const stored = { ...event, event_id: state.lastEventId, project_id: projectId };

    // 3. Append to JSONL (single atomic fs.appendFileSync)
    fs.appendFileSync(eventsPath, JSON.stringify(stored) + '\n');

    // 4. Update in-memory state
    state.clientEventIds.add(event.client_event_id);

    return stored;
  });

  return state.queue;  // Caller awaits the chained result
}
```

**Why this is brilliant:**
- **No busy-waiting** — `.then()` chains are pure event-loop scheduling
- **No mutex/semaphore** — the promise chain IS the serialization
- **No race conditions** — writes to the same project are strictly ordered
- **Different projects are independent** — Project A's queue doesn't block Project B
- **Fault tolerant** — `.catch()` prevents a failed write from breaking the queue permanently

#### Cold Start Initialization

On first access to a project, the store scans the JSONL file to rebuild the in-memory state:

```javascript
async function _initProjectState(projectId) {
  // Stream-parse the JSONL file line-by-line
  // Track: max event_id, all client_event_ids
  // Result: state ready for immediate use, no full file re-read on subsequent calls
}
```

**Concurrent initialization protection:** If two requests hit the same project during cold start, only one `_initProjectState()` runs — others await the same promise:

```javascript
if (!initPromises.has(projectId)) {
  initPromises.set(projectId, _initProjectState(projectId).then(state => {
    projectStates.set(projectId, state);
    initPromises.delete(projectId);
    return state;
  }));
}
return initPromises.get(projectId);  // All callers share the same init promise
```

### 12E. Auth Model — SHA-256 Hashed Keys

```
  relay central create "my-project"
         │
         ▼
  ┌──────────────────────────────────────┐
  │  Generate API key:                   │
  │  central_<48 hex chars>              │
  │                                      │
  │  SHA-256(key) → stored in registry   │
  │  Raw key → returned to user ONCE     │
  │  Raw key → NEVER stored on server    │
  └──────────────────────────────────────┘
         │
         ▼
  User stores key in .relay/central-config.json:
  {
    "serverUrl": "https://relay.example.com",
    "projectId": "p_abc123def456",
    "apiKey": "central_<48 hex chars>"
  }
```

**Two auth levels:**
1. **Admin key** (`RELAY_CENTRAL_ADMIN_KEY` env var) — can create projects, list all projects
2. **Project key** — scoped to a single project ID. The `requireProjectMatch` middleware ensures `req.params.id === req.centralProject.id`

### 12F. Auto-Compile Pipeline

After **every event append**, the Central Relay automatically recompiles the project context:

```
  POST /api/central/projects/:id/events
         │
         ▼
  appendEvent(projectId, event)
         │
         ▼
  compileCentralProject(projectId)      ← Runs synchronously after append
         │
         ▼
  Reads ALL events → Produces:
  ┌──────────────────────────────────────┐
  │  project.md   — Project overview     │
  │  changes.md   — Recent edits by day  │
  │  decisions.md — Open + resolved      │
  │  tasks.md     — Active task list     │
  │  agents.md    — Team + agents seen   │
  └──────────────────────────────────────┘
         │
         ▼
  GET /api/central/projects/:id/context
  → Returns all 5 files joined
  → Agent reads via relay_get_project_context MCP tool
```

**What the compiler does:**
- Groups changes by day, newest first (capped at 200)
- Deduplicates decisions by `decision_id` (latest status wins)
- Deduplicates tasks by `task_id` (latest status wins)
- Tracks agents by `user@agent_source`, sorted by last-seen time

### 12G. The Central Sync Bridge — Client Side

Each local machine runs a **Sync Bridge** (`centralSync.js`) that handles the push/pull lifecycle:

```
  LOCAL MACHINE                           CENTRAL RELAY SERVER
  ─────────────                           ──────────────────────

  ┌─────────────────────┐
  │  memory.json         │
  │  (local timeline)    │
  └──────────┬──────────┘
             │
  PUSH       │  For each new code_edit event:
             │  1. SHA-256(ts + filepath + index) → client_event_id
             │  2. POST /api/central/projects/:id/events
             │  3. On success: advance lastPushedEventTs cursor
             │  4. On fail: STOP (fail-open, resume next sync)
             │
             └─────────────────────────────────────►  Event Store
                                                       (append JSONL)
                                                       (auto-compile)

  PULL       ┌──────────────────────────────────────  Event Store
             │  GET /api/central/.../events?since=N
             │
             ▼
  ┌─────────────────────┐
  │  central_events.jsonl│  ← Append new events from other users
  │  (local cache)       │
  └──────────┬──────────┘
             │
             ▼
  ┌─────────────────────┐
  │  relay_context.md    │  ← Now includes team changes
  │  (handoff bundle)    │  ← Agents see what others did
  └─────────────────────┘
```

**Cursor tracking per machine:**
- `lastPushedEventTs` — what's the latest event I've already pushed?
- `lastPulledCentralEventId` — what's the latest event_id I've already pulled?
- Both stored in `.relay/central-config.json`, updated atomically after each successful operation

### 12H. Event Types — The Three Kinds

| Kind | Purpose | Required Fields | Example |
|------|---------|-----------------|---------|
| `change` | Code edit / file modification | `client_event_id`, `user`, `content`, `file` | "Refactored auth.ts to use JWT" |
| `decision` | Design decision (open or resolved) | `client_event_id`, `user`, `content`, `decision_id`, `status` | "use-postgres: Decided to use PostgreSQL over MongoDB" |
| `task` | Task tracking (open or done) | `client_event_id`, `user`, `content`, `task_id`, `status` | "add-auth: Implement authentication flow" |

Each event also carries:
- `branch` — git branch name (auto-detected)
- `agent_source` — which agent produced this event (e.g., "Claude Code:machine1:session1")
- `ts` — ISO timestamp (auto-filled if not provided)
- `event_id` — server-assigned monotonic integer (for cursor-based pagination)

### 12I. Intra vs Inter — The Complete Comparison

| Dimension | Intra (Local Coordinator) | Inter (Central Relay) |
|-----------|--------------------------|----------------------|
| **Scope** | One machine | All machines, all users |
| **Purpose** | File lock enforcement | Team awareness + change visibility |
| **Enforcement** | Hard block (deny tool execution) | Soft visibility (context + conflict flags) |
| **Data model** | Lock table (`Map<file, holder>`) | Event stream (append-only JSONL) |
| **Network Need** | **100% Offline (Air-gapped)** | Requires LAN or Internet |
| **Auth** | None (localhost only, 127.0.0.1) | SHA-256 API key per project |
| **Port** | Ephemeral (dynamic) | Fixed (3001 or configured) |
| **Latency** | ~60ms (in-memory) | 200–500ms (network) |
| **Failure mode** | Filesystem fallback → fail-open | Fail-open (local agents keep working) |
| **State persistence** | `.relay/locks/*.lock` (TTL, transient) | `~/.relay-os/central/events/*.jsonl` (permanent) |
| **Who talks to it** | Pre-tool hooks (automatic) | MCP tools + Sync Bridge (explicit) |
| **Real-time updates** | SSE push (EventEmitter) | Pull-based (cursor pagination) |
| **Binding** | `127.0.0.1` only | `0.0.0.0` (network-accessible when deployed) |
| **Deployment** | Auto-started daemon (No hosting needed) | Self-hosted or cloud-deployed |

> **Both layers work together.** Intra prevents Claude and Cursor on your laptop from stomping each other's files. Inter prevents your laptop's agents from stomping your teammate's agents' files. Neither blocks the other — if the Central Relay is down, local agents still coordinate locally. If the local Coordinator is down, hooks fall back to filesystem → fail-open. The system degrades gracefully at every boundary.

---

# Part IV — Scrapping Markdown & The Hook Ecosystem

---

## 13. The Great Markdown Purge (Token Optimization)

> **The old way was too heavy.** Forcing every agent to constantly read and write a rigid set of Markdown files (`relay_context.md`, `compile_brief.md`, `project.md`, `changes.md`, `decisions.md`, `tasks.md`) consumed massive context windows and clashed with teams' existing documentation standards. 

We are **completely scrapping** the Markdown generation engine from the core Relay loop. 

**What we are removing:**
1. **Instruction file patching:** Relay will no longer forcefully inject pseudo-commands into `CLAUDE.md`, `AGENTS.md`, or `.cursorrules`.
2. **Context Compilation:** No more `relay context .` generating huge handoff files.
3. **Central Markdown Compilation:** The Central Relay will no longer synthesize `project.md` or `decisions.md`.

**What we are keeping:**
Relay will focus exclusively on its two most powerful, invisible primitives:
1. **File Locking (Intra):** Preventing parallel file corruption.
2. **Chat History Syncing (Inter):** Harvesting agent transcripts into a unified `memory.json` (and syncing to Central) so agents can query the raw timeline of what others did.

By relying on MCP tools (e.g., a new `relay_get_chat_history` tool) rather than force-feeding `.md` files, we drastically reduce token usage and let agents pull exactly the history they need, when they need it.

---

## 14. The Agent Hook Ecosystem (How to Connect)

To make Relay work invisibly without `.md` instructions, we rely entirely on **Pre-Tool Hooks** (for locking) and **Stop Hooks** (for chat history sync).

Here is the exact mapping of how Relay hooks into the 5 supported AI coding agents.

### 14A. Cursor
Cursor supports robust hook definitions in `.cursor/hooks.json`.

- **Pre-Tool Hook:** Triggers right before Cursor attempts to edit a file.
- **Stop Hook:** Triggers at the end of Cursor's generation loop.

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": "node \".relay/hooks/relay-cursor-pre-tool.js\"",
        "matcher": "Write|Edit|str_replace_based_edit_tool|create_file",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": "node \".relay/hooks/relay-cursor-stop.js\"",
        "loop_limit": 1
      }
    ]
  }
}
```

### 14B. Claude Code
Claude Code supports similar hooks in its `.claude/settings.json` file.

- **PreToolUse:** Regex matches `Edit|Write|Replace` to grab locks.
- **Stop:** Wildcard matcher `*` to sync transcripts on exit.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Replace",
        "hooks": [{ "type": "command", "command": "node \".relay/hooks/relay-claude-pre-tool.js\"" }]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "node \".relay/hooks/relay-claude-stop.js\"" }]
      }
    ]
  }
}
```

### 14C. Antigravity (Google)
Antigravity executes highly specific tools for modifying files. We intercept them via `.agents/hooks.json`.

- **PreToolUse:** Matches Antigravity's specific file modification tools (`replace_file_content`, `multi_replace_file_content`, `write_to_file`).
- **Stop:** Syncs chat history when the agent yields back to the user.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*replace_file_content.*|.*write_to_file.*|.*multi_replace_file_content.*",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-antigravity-pre-tool.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node \".relay/hooks/relay-antigravity-stop.js\"",
        "timeout": 120
      }
    ]
  }
}
```

### 14D. GitHub Copilot CLI
Copilot CLI allows cross-platform hooks defined in `.github/hooks/relay-os.json`.

- **preToolUse:** Matches `edit_file|write_file|str_replace_editor`. Defines both bash and powershell executors.
- **agentStop:** Syncs the Copilot session state.

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "node \".relay/hooks/relay-copilot-pre-tool.js\"",
        "powershell": "node \".relay/hooks/relay-copilot-pre-tool.js\"",
        "matcher": "edit_file|write_file|str_replace_editor",
        "cwd": ".",
        "timeoutSec": 10
      }
    ],
    "agentStop": [
      {
        "type": "command",
        "bash": "node \".relay/hooks/relay-copilot-stop.js\"",
        "powershell": "node \".relay/hooks/relay-copilot-stop.js\"",
        "cwd": ".",
        "timeoutSec": 120
      }
    ]
  }
}
```

### 14E. Codex
Codex shares a virtually identical schema to Claude Code, defined in `.codex/hooks.json`.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|Replace",
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-codex-pre-tool.js\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \".relay/hooks/relay-codex-stop.js\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

### Conclusion: The Future is Invisible

By leveraging these hooks and the local `127.0.0.1` Coordinator, Relay achieves cross-agent orchestration without forcing a single line of Markdown into the LLM's context window. 

1. **Pre-Tool Hooks** hit the O(1) Coordinator HTTP endpoint, locking the file in <60ms.
2. **Stop Hooks** harvest the agent's chat transcripts, extracting the code edits into `memory.json`.
3. The **MCP Server** exposes `relay_get_chat_history` so an agent can *choose* to read what happened while it was asleep.

This makes Relay faster, cheaper (tokens), and completely agnostic to the user's personal workflow.

---

## 15. Zero-Init: Global Auto-Run Architecture

> **No more manual setup.** Developers hate typing `relay init` in every single repository. 

Relay is designed to be **always on, everywhere, automatically.** It achieves this by shifting from a per-project script to a **Global Daemon & Native IDE Integration** model.

### 15A. The Global Daemon
Instead of running a local Express server from a `node_modules` folder inside the project, Relay runs as a lightweight **global background service** (e.g., a system tray app on macOS/Windows or a systemd service on Linux).

1. The global daemon binds to `127.0.0.1:3001` upon system startup.
2. It dynamically tracks which workspaces are active based on incoming hook traffic.
3. No `npm install relay-os` or `relay init` is required in individual repositories. 

### 15B. Global Hook Injection
Instead of injecting `.relay/hooks/*` into every individual project folder, the Relay daemon patches the **global agent configurations** once upon installation.

- **Claude Code:** Patches `~/.claude/settings.json` globally, pointing to a global hook binary (e.g., `~/.relay-os/bin/relay-claude-hook`).
- **Cursor/Copilot:** Handled via a native VSCode Extension (`Relay for VSCode`). The extension activates automatically in any workspace and intercepts the IDE's file write events natively, bypassing the need for a `.cursor/hooks.json` file entirely.
- **Antigravity:** Installed as a global custom Plugin (`~/.gemini/config/plugins/relay`), ensuring the PreToolUse and Stop hooks are active across all workspaces automatically.

### 15C. Result: Invisible Magic
When a developer clones a new repo and fires up Claude or Cursor, Relay is already watching. 
- The first time a file edit is attempted, the global hook pings the global daemon.
- The daemon auto-registers the workspace in its internal registry and creates the lock.
- **Zero commands. Zero config files. Zero friction.**

### 15D. The Death of the CLI

Because Relay is now fully integrated into the global hook system and background daemon, **we have completely eliminated all manual user/agent commands.**

*RIP to the legacy commands:*
- ❌ `relay init` (Handled globally upon system installation)
- ❌ `relay watch .` (The global daemon intrinsically watches all registered workspaces via hooks)
- ❌ `relay sync .` (Syncing is automatically triggered by the agent's Stop hook at the end of every turn)
- ❌ `relay compile .` and `relay context .` (The entire Markdown generation engine was deleted)

There are no "pseudo-commands" for agents to type, and no background terminals the user has to keep open. The user experience is perfectly transparent: you just open your IDE and start coding. Relay handles the chaos invisibly.

---

## 16. The Desktop App (Tauri Delivery)

To make the "Global Daemon" actually user-friendly, Relay isn't installed via a terminal command. It is packaged and distributed as a native **Desktop Application**.

### 16A. Why Tauri?
We target **Tauri** (Rust + React/Next.js frontend) instead of Electron.
- **Lightweight:** Tauri apps use the OS's native webview (WebView2 on Windows, WebKit on macOS), resulting in an app bundle that is <20MB and consumes minimal RAM.
- **Battery-Friendly:** Since this daemon needs to run 24/7 in the background listening for hooks on `127.0.0.1:3001`, an Electron app would drain laptop batteries. Tauri's Rust backend is incredibly efficient.

### 16B. The "Always On" UX
The user experience boils down to this single rule: **"As long as the Relay Desktop App is running, everything is good."**

1. **System Tray:** The app lives quietly in the system tray (macOS menu bar or Windows taskbar).
2. **Auto-Start:** It boots silently when the OS starts up.
3. **The Global Daemon:** The Tauri Rust backend automatically spawns and manages the Node.js Coordinator process (`127.0.0.1:3001`). If the Node process crashes, Tauri instantly resurrects it.
4. **Mission Control UI:** Clicking the tray icon opens the beautiful Mission Control frontend, allowing the user to visually see real-time file locks, agent activity streams, and Central Relay sync statuses.

With Tauri, we replace complex terminal daemons and `npm global` installs with a standard, consumer-grade desktop app experience.

---

# Part V — The Multi-User Experience

## 17. The Power of Relay: Inter-Coordination
Relay is designed to solve the chaotic problem of multiple AI agents and human developers working on the same repository simultaneously. While "Intra-Coordination" solves this for a single user, **Inter-Coordination** scales this to distributed teams across the world.

Imagine a restaurant chain where five kitchens in different cities cook the same recipe. If one kitchen changes the recipe, the others need to know instantly. That is the multi-user experience in Relay.

## 18. How it Feels
Using Relay in a multi-user environment feels like magic. There is no git-push/pull ceremony required to see what your teammates (and their agents) are doing. 
You get unparalleled real-time observability of who is working on what, ensuring no two hands touch the same wire at the same time.

### 1. Cross-User File Collisions (Prevented)
If User A's agent (e.g., Cursor) starts editing `src/auth.ts` and User B's agent (e.g., Claude Code) tries to edit the same file:
- User A's daemon acquires a distributed write lock from the Relay Coordinator Service.
- User B's agent is instantly blocked with a structured message: *"File `src/auth.ts` is locked by User A (@alice, Cursor instance). Waiting..."*
- Once User A finishes, the lock is released, and User B's agent unblocks.

### 2. Dependency Awareness
It's not just about the same file. What if User A edits `src/utils/logger.ts`, and User B is editing `src/api/handler.ts` which imports `logger.ts`?
Relay merges the dependency graph across all users at the Coordinator level. User B will receive a soft-lock warning: *"⚠️ `handler.ts` depends on `logger.ts`, which is currently being modified by User A. Proceeding may cause inconsistencies."*

### 3. Real-Time Patch Delivery (The Speed Layer)
The typical agent loop (`edit -> save -> git add -> git commit -> git push -> git pull -> resolve conflicts`) takes minutes. Relay reduces this to milliseconds.
- When an agent saves a file, Relay computes a minimal patch.
- The patch is broadcasted to all connected daemons via WebSockets.
- The receiving daemons apply the patch instantly. No `git` ceremony.
- Operational Transformation (OT) seamlessly resolves any conflicting patches, similar to Google Docs.

### 4. Zero Polling, Instant UI
Relay's Mission Control dashboard doesn't rely on busy-waiting or polling. It uses an **Event-Driven Architecture** with Server-Sent Events (SSE). 
- **Activity Timeline**: A real-time feed of every agent event, prompt, edit, and tool call.
- **Agent Session Chat**: See the exact conversation between your teammates and their agents.
- **Team Activity**: Real-time visibility into the multi-user ecosystem.
- **File Locks**: Watch locks get acquired and released in real-time, with zero latency.

### 5. Advanced Versioning ("Time Travel")
Because every edit is tracked as a localized micro-patch, Relay maintains a high-resolution timeline of all changes. You can rewind to any specific patch, reviewing the exact atomic changes made by any human or AI agent, providing surgical rollback capabilities.

Relay transforms multi-agent and multi-user development from a collision-prone nightmare into a synchronized, high-throughput symphony.
