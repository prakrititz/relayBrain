# Architecture

---

## Process model

`relay serve` starts one Node process that binds three things:

```
┌─ relay serve (one process) ──────────────────────────────────────┐
│                                                                  │
│  API server            127.0.0.1:3001   (RELAY_PORT)             │
│    ├── /api/*          REST + SSE                                │
│    ├── /mcp            MCP over HTTP, read-only for remotes      │
│    ├── /ws/patches     patch fan-out                             │
│    └── /ws/control     lock RPC (claim/release/heartbeat/read)   │
│                                                                  │
│  Coordinator           127.0.0.1:<ephemeral>                     │
│    └── owns the LockTable instance                               │
│                                                                  │
│  Mission Control       localhost:3002   (RELAY_UI_PORT)          │
│    └── spawned as a child `next dev`; skipped with --no-ui       │
└──────────────────────────────────────────────────────────────────┘
```

The API server and the coordinator share **one** `LockTable` instance in memory — the
coordinator is created by `backend/server.js` via `createCoordinator()`, not run as a
separate process. `backend/coordinator/server.js` can also run standalone
(`npm run coordinator`), which is useful for testing the lock table in isolation.

The API port is fixed and therefore the one target that cannot go stale. The coordinator
port is ephemeral and published to `coordinator-state.json` — but only *after* the API
port successfully binds, so a second `relay serve` that dies on `EADDRINUSE` cannot
overwrite the live instance's pointer with a port that is about to disappear.

Agents run as separate processes entirely. Each hook invocation is its own short-lived
Node process.

---

## The two planes

Relay separates what **arbitrates** from what is **displayed**, and they fail
independently.

### Control plane — claims, releases, heartbeats

```
agent's write tool
   │
   ▼
pre-tool hook (short-lived node process)
   │  POST /api/coord/claim
   ▼
local API on 127.0.0.1:3001
   │
   ├── host or solo → LockTable.claim() directly
   └── guest        → WebSocket RPC to host /ws/control → host's LockTable
```

The fallback chain, in order, with a 3 s total budget:

1. **Local API** (`/api/coord/claim`, ~800 ms budget). Loopback; a guest's request is
   forwarded from here over the control socket.
2. **Room HTTP** (`POST <tunnel>/api/coord/claim`, 2 s). Guests only, and only when the
   room has not been marked down. A failed room call starts a 30 s cooldown so a sleeping
   host does not cost every hook three full timeouts.
3. **Coordinator port** (`POST /claim`) read from `coordinator-state.json`.
4. **Filesystem claim** — write `<locks>/<sha256(file)[:16]>.lock` with the `wx` flag.
   This arbitrates correctly between agents even with no server running.
5. **Fail open** — allow the tool and log `COORDINATOR_UNAVAILABLE`.

A host never routes its own hooks out through its tunnel and back; the host *is* the
coordinator.

### View plane — the board

```
LockTable ── "change" ──┬── SSE  /api/locks/stream
                        ├── SSE  /api/events
                        └── WS   /ws/control  (locks frames to guests)

guest's board ◄── RoomLockMirror (polls host /api/locks) ── host
```

Because the mirror polls on its own clock, a lock claimed a moment ago has not necessarily
landed on a guest's board yet — and a guest whose mirror never started will see an empty
board while its locks arbitrate perfectly. This is exactly the case `relay doctor` was
written to name.

The lock table also re-scans its workspace's `.relay/locks` directory (gated on the
directory's mtime, and at most once a second) so that locks written by fail-open hooks in
other processes still surface on the board.

---

## The life of one edit

An agent in a joined room is about to run `Edit` on `src/auth.ts`.

1. **Pre-tool hook fires.** It reads the JSON payload on stdin, identifies the product
   from the payload's fingerprint, and resolves the workspace root.
2. **Paths are extracted.** An explicit field list is tried first, then a recursive scan
   for any key matching the path-key pattern. Paths are unquoted, `file://`-decoded, made
   workspace-relative, and anything escaping the root is discarded.
3. **`/api/ensure-workspace`** is posted fire-and-forget, so an unregistered workspace
   registers itself.
4. **Dependencies are computed** for each file from the tree-sitter import graph.
5. **The claim goes out** with a 15 s TTL, the dependency list, the full file list for a
   multi-file edit, and a holder object (`label`, `host`, `login`).
6. **The host's lock table decides.** A live write lock held by a different owner refuses
   the claim (HTTP 409) and records the refusing agent as a *waiter*. A stale lock is
   swept. A read lock is displaced. The same owner renews.
7. **Soft blocks are evaluated.** If an upstream import, or another file in the same
   strongly-connected component, is held by someone else, the claim still succeeds but
   carries a `warning`.
8. **The hook answers in the agent's dialect** — Cursor's `{permission}`, Antigravity's
   `{decision}`, Copilot's flat `{permissionDecision}`, or the `hookSpecificOutput`
   envelope for Claude Code and Codex. On deny it also writes the reason to stderr and
   sets exit code 2.
9. **The agent writes the file** (or picks a different task).
10. **Post-tool hook fires.** It posts `/api/flush-file`, which computes a patch and fans
    it out to peers over `/ws/patches`, then releases the lock.
11. **The released lock lingers** on the board for 45 s so a 100 ms claim-release cycle is
    still visible.
12. **Stop hook fires** at end of turn: flush everything this agent still owns, release
    all its locks, and post `/api/ingest-stop` to harvest the transcript into the unified
    history.

---

## Data flow between machines

```
                    ┌──────────────── HOST ────────────────┐
                    │  relay serve                         │
   ngrok tunnel ───►│   • LockTable  (the shared mutex)    │
                    │   • /ws/control  lock RPC            │
                    │   • /ws/patches  patch fan-out       │
                    │   • /api/room/*  membership          │
                    │   • /mcp         read-only context   │
                    └───────────────┬──────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        GUEST relay           GUEST relay           MCP client
        • own clone           • own clone           (no relay needed)
        • lock mirror         • lock mirror         read-only
        • own agents          • own agents
```

Three separate channels do three separate jobs:

| Channel | Carries | Direction |
|---|---|---|
| `/ws/control` | claim, release, heartbeat, release-all, read | guest → host, RPC with reply |
| `/ws/patches` | patches, history snapshots, hello/locks frames | both ways, fan-out |
| `/api/room/state` | the host's aggregated chats, timeline, activity, edits | guest pulls |

The control socket is deliberately small and rate-limited (64 KB max frame, 60 RPCs per
second per socket). Identity is decided once at the handshake and never re-read from a
frame — a socket cannot claim to be someone else mid-session, and a kicked member's next
frame closes the socket with `4401 membership_revoked`.

---

## Storage

Everything is a JSON file. Nothing is a database.

| | Where | Contains |
|---|---|---|
| Registry | `~/.relay/data/registry.json` | projects, users |
| Session | `~/.relay/data/session.json` | signed-in user, selected project |
| Memory | `~/.relay/data/projects/<id>/memory.json` | history, chats, timeline, edits, patches, `patchBuffer`, `lastAppliedLamport`, `agents`, `roomPeers`, `stats` |
| Collisions | `~/.relay/data/projects/<id>/collisions.json` | authoritative counters |
| Collisions mirror | `<repo>/.relay/collisions.json` | git-visible copy |
| Room | `~/.relay/room.json` and `<repo>/.relay/room.json` | role, url, roomId, invite + member-token **hashes** |
| Coordinator state | `~/.relay/coordinator-state.json` and `<repo>/.relay/coordinator-state.json` | `port`, `apiPort`, `pid`, `startedAt` |
| Locks | `<repo>/.relay/locks/*.lock` | one file per live lock |

`room.json` is a credential store — it holds hashed invite codes and member tokens, plus
this machine's own `memberToken` in the clear. It is never served raw: `/api/room` and
`/api/health` both pass it through `publicRoom()`, which strips `invites`, `memberTokens`,
`members`, `memberToken` and `nonce`.

---

## Module map

| Path | Responsibility |
|---|---|
| `cli/relay.js` | Command dispatch, `relay serve` supervision, `relay doctor` |
| `backend/server.js` | API server, room orchestration, WebSocket servers |
| `backend/coordinator/lockTable.js` | The lock table: claim, release, heartbeat, reads, waiters, sweep |
| `backend/coordinator/server.js` | Coordinator HTTP surface and `createCoordinator()` |
| `backend/coordinator/client.js` | The fallback chain hooks use to reach a coordinator |
| `backend/lib/depGraph.js` | Import graph, Tarjan SCC, soft blocks |
| `backend/lib/treeSitterImports.js` | tree-sitter import extraction per language |
| `backend/lib/patches.js` | Patch compute, record, apply, rewind |
| `backend/lib/ot.js`, `lamport.js` | Ordering and pairwise transform |
| `backend/lib/room.js` | Room file, ngrok tunnel lifecycle, membership rows |
| `backend/lib/roomAuth.js` | Invite codes, member tokens, `publicRoom`, remote detection |
| `backend/lib/roomLocks.js`, `roomControl.js`, `roomSync.js` | Lock mirror, control socket, peer snapshot merge |
| `backend/lib/transcripts/` | Discover, parse and sync agent transcripts |
| `backend/lib/installHooks.js`, `installAgentRelay.js` | Writing hooks, MCP config and instructions |
| `backend/mcp/tools.js` | The MCP tool surface, transport-independent |
| `hooks/relay-hook-lib.js` | Shared hook implementation for all five agents |
| `mission-control/` | Next.js dashboard |
| `landing/` | Marketing site and hosted docs |

The twenty `hooks/relay-<agent>-<phase>.js` files are thin shims: each one calls into
`relay-hook-lib.js` with its declared mode. The declared mode is only a fallback — the
library re-detects the actual product from the payload.
