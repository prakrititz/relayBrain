# Querying the room

Relay collects every member's agent transcripts, edits, locks and presence into
one place. This is how an agent — or a shell script, or you — asks that store a
question.

Relay does not answer questions. It scopes and returns facts; whoever asked does
the interpreting. That is deliberate: the caller is already a language model, so
a second one in the middle would only add cost, latency and a way to be wrong.

## The one thing to know

**Reads are room-wide. Writes are local.**

Anything that reads — chat history, edits, locks, conflicts — answers for every
member of the room. Anything that writes — claiming a lock, reporting a change —
only ever runs against the relay on your own machine, over the transport that
still works when the tunnel does not.

## Two transports, one tool surface

Both are served by [`tools.js`](./tools.js). They expose the same fifteen tools.

### stdio — what your agents already use

`backend/mcp/server.js`, started by the agent itself. Nothing to configure; if
relay is installed, this already works, and after this change its reads span the
room instead of just this machine.

### HTTP — through the room tunnel

`POST /mcp` on the host. For an agent on another machine, or one on a box with
no relay installed at all. Print the config with:

```
relay mcp-url
```

```json
{
  "mcpServers": {
    "relay-room": {
      "type": "http",
      "url": "https://<tunnel>.ngrok-free.app/mcp",
      "headers": {
        "ngrok-skip-browser-warning": "relay",
        "x-relay-room-token": "<your member token>"
      }
    }
  }
}
```

Stateless — no session id is issued, so there is nothing to expire. `GET /mcp`
and `DELETE /mcp` answer `405`; a client that asks for the optional event stream
just stops asking.

**Anyone arriving from off-machine gets the seven read tools only.** Claiming a
lock as the host would file it under the host's workspace, the host's user, and
an agent id the host cannot verify — and would put a second writer on a lock
table that has exactly one on purpose. `tools/list` hides the other six, so a
remote agent never sees a tool it cannot call.

## What you can ask

| Tool | Answers |
|---|---|
| `relay_get_chat_history` | what everyone told their agents to do, and what the agents said back |
| `relay_room_brief` | teammate activity brief — **`/relay ask`** in Cursor, Claude, Codex, Copilot, Antigravity |
| `relay_get_recent_changes` | which files changed, by whom, with diffs |
| `relay_status` | who holds which lock right now |
| `relay_get_conflicts` | who edited the same file as someone else in the last 5 minutes |
| `relay_get_collision_stats` | lifetime counters for collisions Relay prevented |
| `relay_get_project_context` | Central's view: changes, decisions, tasks, agents |
| `relay_get_decisions` / `relay_get_active_tasks` | the decision and task logs |

Writers (local only): `relay_claim_file`, `relay_release_file`,
`relay_report_change`, `relay_report_decision`, `relay_update_task`,
`relay_sync`.

### Scoping a question

`relay_get_chat_history` takes `agent`, `ownerLogin` and `limit`. Those three
are the whole query language — "who, which agent, how much".

```jsonc
// What is ana's Antigravity working on?
{ "ownerLogin": "ana", "agent": "Antigravity", "limit": 20 }

// Everything Claude Code has done in this room, whoever is driving it
{ "agent": "Claude Code" }

// The last 5 events from anyone
{ "limit": 5 }
```

`limit` defaults to 50 and is capped at 200 — memory.json is much larger than
any context window, and a remote read has to cross a tunnel to get here.

### What comes back

```jsonc
{
  "history": [ /* oldest first, so the last entry is the newest */
    {
      "ts": 1786996380114,
      "tsIso": "2026-08-17T19:53:00.114Z",
      "agent": "Claude Code",
      "ownerLogin": "prakrititz",
      "sessionId": "03e3a558-…",
      "role": "tool",
      "kind": "code_edit",
      "text": "Edit lockgraph.module.css",
      "file": "lockgraph.module.css",
      "diff": "--- a/lockgraph.module.css\n+++ b/…"
    }
  ],
  "chats":  [ { "id": "chat_claude-code_03e3…", "agent": "Claude Code",
                "ownerLogin": "prakrititz", "mine": true,
                "updatedAt": 1786996380114, "messages": [ /* … */ ] } ],
  "timeline": [ /* … */ ],
  "room": { "source": "host", "peers": ["ana"], "peer_snapshot_age_ms": 0 }
}
```

`relay_get_recent_changes` returns `edits`, each with `file`, `agent`,
`ownerLogin`, `ts` and `diff`. `relay_get_conflicts` returns `conflicts`. Both
carry the same `room` block.

## Reading the `room` block

Every read says where its answer came from and how old it is, because the
freshness is genuinely uneven: locks move room-wide in ~150ms, but transcripts
only travel on the 8s dashboard poll, and only when they changed. "What file are
they in" is live; "what did they ask it to do" can be a few seconds behind. That
is a judgment call about whether it's fresh enough for what you're about to do,
so the caller gets to make it.

| `source` | Means |
|---|---|
| `host` | asked the host just now; `peer_snapshot_age_ms` is under a second |
| `local_snapshot` | the host did not answer — this is the last sync, `peer_snapshot_age_ms` says how old |
| `solo` | not in a room; there are no peers to see |

**A guest whose host is offline still gets an answer.** roomSync parks every
peer's snapshot in your own `memory.json`, so the fallback is stale rather than
empty. The tunnel being down costs one short timeout and never an error.

Four reads in a row make one trip through the tunnel — the host response is
cached for a second, which is short enough that nothing is meaningfully staler
than a single request would have been.

## Worked example

An agent about to edit a locked file, asking who is in its way:

```jsonc
// relay_status — keyed "<workspaceId>::<filePath>"
{ "locks": {
    "C:\\repos\\relay.it::src/auth.ts": {
      "filePath": "src/auth.ts", "holder": "ana", "agentId": "antigravity:ana",
      "mode": "write", "claimedAt": 1786996352000, "ttlMs": 40000,
      "expiresAt": 1786996392000, "readers": [], "escalated": false
    } },
  "uptime": 812.4 }

// relay_get_chat_history { "ownerLogin": "ana", "agent": "Antigravity", "limit": 5 }
// → "make the session cookie httpOnly"

// relay_get_recent_changes → ana has touched auth.ts, session.ts, auth.test.ts
```

Three calls, no model in the middle, and the agent can decide for itself: work
on the other module, or wait deliberately. The lock stopped being a wall and
started being an explanation.

## Troubleshooting

**`"source": "solo"` but you are in a room.** `loadRoom()` found no room for
this workspace. Check `.relay/room.json` in the repo, or `~/.relay/room.json`.

**`401 not_a_member` on the HTTP endpoint.** The host made the room
invite-only and your member token is missing or revoked. Re-join with the invite
link, then `relay mcp-url` again.

**A remote call returns "not available to remote callers".** Working as
intended — that tool writes. Call it against your own relay over stdio.

**Peers visible in Mission Control but not from MCP.** Both read the same merge
now, so this should not happen; if it does, `relay doctor` on the machine that
sees nothing is the place to start.
