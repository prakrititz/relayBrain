# MCP reference

Relay exposes the same fifteen tools over two transports. The tool surface itself
(`backend/mcp/tools.js`) has no transport attached — both feed it a context object, so
neither grows its own copy of the logic.

| Transport | Started by | Reaches | Access |
|---|---|---|---|
| **stdio** — `backend/mcp/server.js` | The agent, one process per session | This machine | Full: all fifteen tools |
| **HTTP** — `POST /mcp` | Any MCP client, over the room tunnel | The host | Read-only for remotes: nine tools |

Protocol version: `2024-11-05`. Server info: `{ name: "relay", version: "0.1.0" }`.

---

## Local setup (stdio)

`relay add`, `relay clone` and `relay init` write this automatically into every agent's
config:

| Agent | File | Key |
|---|---|---|
| Claude Code | `.claude/settings.json` | `mcpServers.relay` |
| Cursor | `.cursor/mcp.json` | `mcpServers.relay` |
| Codex | `.codex/config.toml` | `[mcp_servers.relay]` |
| Copilot CLI | `.github/mcp.json` | `mcpServers.relay` (`type: "local"`, `tools: ["*"]`) |
| Antigravity | `.agents/mcp_config.json` | `mcpServers.relay` |

The entry is the current Node executable running `backend/mcp/server.js`, with
`RELAY_WORKSPACE_PATH` set to the workspace. Global equivalents are written into your home
directory with no workspace pinned.

Existing `mcpServers` entries are merged, not replaced.

## Room setup (HTTP)

```bash
relay mcp-url
```

prints a ready-to-paste block:

```json
{
  "mcpServers": {
    "relay-room": {
      "type": "http",
      "url": "https://<tunnel>.ngrok-free.app/mcp",
      "headers": {
        "ngrok-skip-browser-warning": "relay",
        "x-relay-room-token": "rlm_…"
      }
    }
  }
}
```

This works from a machine with no Relay installed at all. It is read-only.

---

## Read-only boundary

Nine tools are available to remote callers:

`relay_get_chat_history` · `relay_status` · `relay_get_project_context` ·
`relay_get_recent_changes` · `relay_get_decisions` · `relay_get_active_tasks` ·
`relay_get_conflicts` · `relay_room_brief` · `relay_get_collision_stats`

Everything else writes somewhere — the lock table, Central, `memory.json` — and would
write it as *the host*: the host's workspace path, the host's user, an agent ID the host
cannot verify. A guest already has a local relay for those, on a transport that works when
the tunnel does not. So the remote surface stays a read.

Calling a write tool remotely returns
`<name> is not available to remote callers - run it against your own relay.`, and
`tools/list` does not advertise it in the first place.

---

## Tools

### Coordination

#### `relay_claim_file` *(local only)*

Acquire an exclusive write lock before editing. Dependencies are computed automatically
from the import graph.

```jsonc
{ "file": "src/auth.ts", "ttl_ms": 15000 }   // file required
```

#### `relay_release_file` *(local only)*

`{ "file": "src/auth.ts" }` — release after editing.

#### `relay_status`

The full lock table for this workspace. No arguments.

---

### Room awareness

#### `relay_room_brief`

The tool behind `/relay ask`, and the one worth wiring first. It syncs transcripts,
assembles the room view and compiles a teammate activity brief: peer chat, code edits,
tool activity and live locks.

```jsonc
{ "limit": 30 }   // clamped to 5–80
```

Returns `{ markdown, data, room }`. `markdown` is the human-readable brief; `data` is the
same content structured; `room` reports where the answer came from.

#### `relay_get_chat_history`

Unified agent chat, time-ordered. In a room this spans every member.

```jsonc
{ "agent": "Cursor", "ownerLogin": "ana", "limit": 50 }
```

Returns `{ history, chats, timeline, room }`. `limit` defaults to 50 and is capped at 200.

#### `relay_get_recent_changes`

Recent `code_edit` events → `{ edits, room }`.

#### `relay_get_conflicts`

Files touched by two or more agents in the last five minutes → `{ conflicts, room }`.

#### `relay_get_collision_stats`

Lifetime counters for collisions Relay prevented, merged across the room:
`{ collisions, local, room }`. See
[Locking → Collision counters](./LOCKING.md#collision-counters).

#### `relay_sync` *(local only)*

Re-reads agent transcripts into unified history → `{ ok, events, chats }`.

---

### Project context (Central)

#### `relay_get_project_context`

Full JSON context compiled from the last 500 Central events.

#### `relay_report_change` *(local only)*

`{ file, content }` — append a `change` event.

#### `relay_report_decision` *(local only)* · `relay_get_decisions`

`{ decision_id, decision, status }` (status defaults to `open`) and the read side.

#### `relay_update_task` *(local only)* · `relay_get_active_tasks`

`{ task_id, description, status }` (status defaults to `open`) and the read side.

---

## The `room` field

Every room-aware tool returns a `room` object describing where its answer came from:

```jsonc
{ "source": "host", "peers": ["bo", "cy"], "peer_snapshot_age_ms": 340 }
```

| `source` | Meaning |
|---|---|
| `host` | Fetched live from the host through the tunnel |
| `local_snapshot` | The tunnel was unreachable; answered from the last stored peer snapshot |
| `solo` | Not in a room; local data only |

A host never leaves the process — it already holds every peer snapshot locally. A guest
asks the host with a **1.5 s** timeout, and caches the response for **1 s** so an agent
calling three read tools in a row does not pay three tunnel round trips.

---

## Context resolution

The stdio server builds its context from the environment:

| Variable | Default |
|---|---|
| `RELAY_WORKSPACE_PATH` | `process.cwd()` |
| `RELAY_PROJECT_ID` | The project matching the workspace, else the first registered |
| `RELAY_AGENT_ID` | `mcp:local:stdio` |
| `RELAY_USER`, `RELAY_OWNER` | `local` |
| `RELAY_CENTRAL_PROJECT_ID` | Falls back to the project id |

The HTTP transport builds its context from the request: the selected project, the
authenticated viewer's login, an agent ID of `mcp:http:<login|guest|local>`, and
`readOnly` set from whether the request is remote.

---

## The `/relay ask` convention

`/relay ask` is **not** a built-in slash command and **not** a terminal command. It is a
project convention, documented in the relay-os block that `relay init` writes into
`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/relay.mdc` and
`.github/copilot-instructions.md`.

When you type it, the agent is instructed to call the MCP tool `relay_room_brief` on the
server named `relay`, and to summarize teammate chat, code edits, locks and file-sync
notes before touching shared files.

If the agent replies that the `relay` MCP server is missing, run `relay add .` (or
`relay init`) and restart the agent.
