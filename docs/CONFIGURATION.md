# Configuration

Relay has no configuration file of its own. Behaviour is controlled by environment
variables, a small optional override file, and the state files it maintains.

---

## Environment variables

### Ports and origins

| Variable | Default | Effect |
|---|---|---|
| `RELAY_PORT` | `3001` | API server port. Also what hooks and the coordinator client dial. `relay serve --port N` overrides it for the server, and is exported to the child processes. |
| `RELAY_UI_PORT` | `3002` | Mission Control port. |
| `RELAY_UI_ORIGIN` | `http://localhost:<RELAY_UI_PORT>` | Allowed CORS origin, and where the GitHub OAuth callback redirects. |
| `RELAY_COORDINATOR_PORT` | `0` (ephemeral) | Preferred coordinator port. On `EADDRINUSE` an ephemeral port is used instead. |
| `NEXT_PUBLIC_RELAY_API` | set by `relay serve` | The API origin Mission Control talks to. |

### GitHub

| Variable | Effect |
|---|---|
| `GITHUB_CLIENT_ID` | Enables the OAuth device flow for `relay login`, and makes `/api/session` report `oauthConfigured: true`. |
| `GITHUB_CLIENT_SECRET` | Required, with the client id, for the browser sign-in flow at `/api/auth/github`. |

### Hook and agent context

| Variable | Effect |
|---|---|
| `RELAY_WORKSPACE_PATH` | Forces the workspace root a hook or MCP server uses. Written into every MCP config by `relay init`. |
| `RELAY_HOOK_DEBUG` | `1` appends a JSON line per hook invocation to `~/.relay/hook-debug.log`. |
| `RELAY_AGENT_ID` | Agent id for the stdio MCP server. Default `mcp:local:stdio`. |
| `RELAY_PROJECT_ID` | Pins the project the MCP server answers for. |
| `RELAY_USER`, `RELAY_OWNER` | Identity attributed to MCP writes. Default `local`. |
| `RELAY_CENTRAL_PROJECT_ID` | Central project for MCP event writes. Falls back to the project id. |
| `SESSION_ID` | Last-resort session component of the agent id. |

### Locking

| Variable | Default | Effect |
|---|---|---|
| `RELAY_LOCK_DEPTH` | `1` | How many dependency hops out to consider for soft blocks. `.relay/deps.json` wins over this. |

### Rooms

| Variable | Effect |
|---|---|
| `RELAY_ROOM_URL` | Forces a room URL, bypassing `room.json` entirely. |
| `RELAY_ROOM_ROLE` | `host` or `guest`. Default `guest`. Only read alongside `RELAY_ROOM_URL`. |
| `RELAY_ROOM_PROJECT` | Host project id to pair with `RELAY_ROOM_URL`. |

### Central

| Variable | Effect |
|---|---|
| `RELAY_CENTRAL_ADMIN_KEY` | Admin credential for the `/api/central/*` routes. |

### Read by the environment, not set by Relay

`CLAUDE_CODE_CHILD_SESSION`, `COPILOT_AGENT_PROMPT` and `GITHUB_COPILOT_API_TOKEN` are
read by `detectProduct()` as evidence of which agent is running a hook.

---

## `.relay/deps.json` — dependency graph overrides

Optional, per repository. Not created for you.

```json
{
  "lockDepth": 2,
  "edges": [
    ["src/api/routes.ts", "src/db/schema.ts"],
    ["src/worker/index.ts", "src/config/queue.ts"]
  ]
}
```

| Key | Meaning |
|---|---|
| `lockDepth` | Hops out from the edited file when evaluating soft blocks. Default 1. |
| `edges` | Extra `[from, to]` dependencies tree-sitter cannot see — generated code, runtime wiring, config-driven imports. |

Raising `lockDepth` widens the blast radius Relay warns about. It never turns a warning
into a refusal; soft blocks are always advisory.

---

## On-disk layout

### `~/.relay/`

```
~/.relay/
├── data/
│   ├── registry.json                    projects[], users[]
│   ├── session.json                     userId, login, projectId
│   └── projects/<projectId>/
│       ├── memory.json                  history, chats, timeline, edits,
│       │                                patches, patchBuffer,
│       │                                lastAppliedLamport, agents,
│       │                                roomPeers, stats
│       └── collisions.json              authoritative counters
├── room.json                            machine-wide room membership
├── coordinator-state.json               { port, apiPort, pid, startedAt }
├── locks/                               fallback lock files
└── hook-debug.log                       only with RELAY_HOOK_DEBUG=1
```

### `<repo>/.relay/`

```
<repo>/.relay/
├── AGENT_BOOTSTRAP.md                   what every agent reads first
├── room.json                            room membership for this workspace
├── coordinator-state.json               live ports
├── collisions.json                      git-visible mirror of the counters
├── relay_ask.md                         last /relay ask brief
├── deps.json                            optional, yours
├── locks/
│   └── <sha256[:16]>.lock
└── .handshake_<Agent>
```

Relay writes room and coordinator state to **both** the home directory and the workspace,
and reads the workspace copy first. If the workspace's `.relay` directory cannot be
created — a missing drive letter, an unplugged disk, a host path from another OS — it
falls back to `~/.relay` rather than failing the operation.

---

## Ports at a glance

| Port | Bound by | Interface |
|---|---|---|
| 3001 | API server | `127.0.0.1` only |
| 3002 | Mission Control | localhost |
| ephemeral | Coordinator | `127.0.0.1` only |
| 4040 | ngrok's own inspector | localhost, read by Relay |

The API server binds `127.0.0.1` explicitly. It is reachable from outside **only** through
the ngrok tunnel you start yourself, and only while you are hosting a room.

---

## Ignoring Relay state in git

`.relay/` holds live coordination state — ports, PIDs, lock files, room membership
including this machine's own member token in the clear. Most teams should ignore it:

```gitignore
.relay/
```

Keep in mind that `collisions.json` is deliberately mirrored into the repository so the
counter is git-visible if you want it there. If you do, ignore selectively instead:

```gitignore
.relay/*
!.relay/collisions.json
```

The agent config files (`.claude/`, `.cursor/`, `.codex/`, `.github/`, `.agents/`,
`AGENTS.md`, `CLAUDE.md`, `.cursorrules`) are ordinary project files. Commit them if you
want teammates to inherit the wiring; note that hook commands are absolute paths into your
own Relay checkout, so each teammate still needs to run `relay init` locally.
