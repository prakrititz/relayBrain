# HTTP API reference

The API server binds `127.0.0.1:<RELAY_PORT>` (default 3001). When the machine is hosting
a room, the same server is also reachable through the ngrok tunnel — which is why the
authorization rules below matter.

All request and response bodies are JSON. The body limit is **2 MB**, except
`/api/room/history` at **32 MB**.

**CORS** is allowed for `RELAY_UI_ORIGIN` (default `http://localhost:3002`),
`http://127.0.0.1:3002`, `http://localhost:3000`, `http://127.0.0.1:3000`, and any
`*.ngrok.app`, `*.ngrok-free.app` or `*.ngrok.io` origin, with credentials.

---

## Authorization

Three middlewares guard the routes.

| Marker | Rule |
|---|---|
| *(none)* | Open. Local and remote callers alike. |
| `requireRoomMember` | Local callers always pass. A remote caller passes only when this machine is hosting and either the room is `open` or the caller presents a valid member token. Otherwise **401 `not_a_member`**. |
| `requireLocal` | Remote callers are rejected with **403 `host_only`**. |
| `requireCentral` | Requires an `Authorization` header resolvable by `centralAuth`. Otherwise **401 `unauthorized`**. |

A request counts as **remote** when it carries `X-Forwarded-For` or
`X-Original-Forwarded-For` (which ngrok and any reverse proxy stamp, and a remote caller
cannot strip), or when its socket address is not loopback. Local Mission Control and local
hooks therefore stay unauthenticated, so adding room security never breaks solo use.

The **member token** is read from, in order: the `x-relay-room-token` header, an
`Authorization: Room <token>` header, or a `token` query parameter.

`requireRoomMember` also identifies the caller from its token even on a loopback request,
because downstream scoping depends on knowing "this is a peer" — and inferring that from
proxy headers alone is a guess, whereas the token is proof.

---

## Health and session

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.1.0",
  "coordinatorPort": 51234,
  "auth": true,
  "room": { "role": "host", "url": "https://…", "roomId": "rlr_…", "memberCount": 3 }
}
```

`room` is passed through `publicRoom()`, which strips `invites`, `memberTokens`,
`members`, `memberToken` and `nonce`. This route is reachable through the tunnel without
credentials — it is what a joining guest probes.

### `GET /api/session`

Current user, all known users, selected project id, and `oauthConfigured` (whether
`GITHUB_CLIENT_ID` is set).

### `POST /api/auth/login`

`{ login }` → selects an existing local user. Emits a `presence` SSE event.

### `GET /api/auth/github`

Redirects to GitHub's authorize URL. **501 `oauth_not_configured`** when
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are unset.

### `GET /api/auth/github/callback`

Exchanges `?code`, creates the user if new, saves the session, and redirects to
`RELAY_UI_ORIGIN`.

### `POST /api/auth/logout`

Clears `userId` and `login`, keeps the selected project.

---

## Projects

### `GET /api/projects`

`{ projects: [...] }` from the registry.

### `POST /api/projects`

| Field | Notes |
|---|---|
| `mode` | `"clone"` to git-clone `remoteUrl`; anything else attaches `path` |
| `remoteUrl` | Required when `mode === "clone"` |
| `path` | Required otherwise |
| `name` | Optional display name |

**201** `{ project }`. **400** on a missing field or a clone failure. Starts watching the
workspace and emits a `projects` SSE event.

### `GET /api/projects/:id` · `PATCH /api/projects/:id`

Fetch, or rename via `{ name }`. **404 `not_found`** when unknown.

### `DELETE /api/projects/:id?mode=leave|remove`

- `leave` (default) — unregister the project; the checkout stays on disk.
- `remove` — also delete `~/.relay/data/projects/<id>/`. The checkout is still never
  touched.

Stops the filesystem and transcript watchers, reselects another project if this one was
current, and answers `{ ok: true, mode, nextId }`. Deliberately never surfaces a 500 — a
missing path or a stale room must not make unregistering fail.

### `POST /api/projects/:id/select`

Selects the project and returns `{ project, dashboard }`.

### `POST /api/projects/:id/sync`

Re-reads agent transcripts into unified memory, pushes local edits to Central and pulls
Central changes in the background, republishes the dependency graph, and returns
`{ ok, lastSyncAt, chats, history }` (counts).

### `GET /api/projects/:id/dashboard`

The main board payload: locks, reads, dependency-graph snapshot, patches,
`lastAppliedLamport`, collaborators (GitHub collaborators overlaid with room members),
`room` (with `hostReachable` and `lastHostContactAt`), `invites` (host, local request
only) and `openRooms` (local request only).

In a room this also opportunistically pushes and pulls room history and refreshes the
guest's roster — but never blocks on the tunnel to do it.

### `GET /api/projects/:id/graph` · `requireRoomMember`

Rebuilds and returns the dependency-graph snapshot, with currently locked files marked.
See [Locking → The graph on the board](./LOCKING.md#the-graph-on-the-board).

### `GET /api/projects/:id/history`

`{ history, chats, timeline }` from `memory.json` (the `ir` blob is omitted).

### `GET /api/projects/:id/conflicts`

`{ conflicts }` — files touched by two or more agents in the last five minutes.

### `GET /api/projects/:id/patches`

`{ patches, lastAppliedLamport }`.

### `POST /api/projects/:id/rewind`

`{ lamport }` → replays every patch at or below that clock, keeping the latest per file,
and writes them to disk. Returns `{ ok, lamport, files, applied, patches }` and emits a
`rewind` SSE event.

---

## Locks and coordination

### `POST /api/coord/claim` · `requireRoomMember`

The main claim route. On a guest it is forwarded over the control socket to the host.

If the tunnel is down, a **write** claim is refused rather than granted from the local
table. The local table is not the shared mutex and does not mirror it — host lock pushes
land in the board's `roomLocks` view, never in the table this route would consult — so a
lock another member is holding looks free here every time. A `read` claim is advisory and
still recorded locally.

```jsonc
{
  "agentId": "Claude Code:ana-laptop:sess_9f3a",
  "file": "src/auth.ts",
  "files": ["src/auth.ts", "src/routes.ts"],   // optional batch
  "workspaceId": "/home/ana/repo",
  "ttl": 15000,
  "mode": "write",
  "dependsOn": ["src/db.ts"],
  "holder": { "label": "Claude Code", "host": "ana-laptop", "login": "ana" }
}
```

**200** `{ allowed: true, warning?, lock?, renewed?, batch? }` ·
**409** `{ allowed: false, holder, reason }` · **400** `{ error: "agent_required" }` ·
**503** `{ allowed: false, degraded: true, source: "local_fallback", reason: "control_offline" }`.

Guest responses carry a `source`: `host` when the room actually answered, `local_fallback`
when it did not. A body with `degraded: true` is not a verdict — it means the room was
never asked — and `coordinator/client.js` treats it as a reason to keep walking its
fallback ladder rather than as an answer.

Every field is re-validated server-side: `agentId` is capped at 200 characters, `file` at
1024, `files` and `dependsOn` at 64 entries each, and `mode` is coerced to `read` or
`write`. For a remote caller the authenticated login is appended to `agentId` and stamped
onto `holder.login`, so a member cannot claim or release as somebody else.

A refused claim increments the `claimsBlocked` collision counter.

### `POST /api/coord/release` · `requireRoomMember`

`{ agentId, file, workspaceId }` → `{ ok, released }`, or
`{ ok: false, reason: "not_holder", holder }`.

On a guest whose tunnel is down the release is applied locally and **queued for replay**,
answering `{ ok, released, source: "local_fallback", degraded: true, queued: true }`. The
queue is drained in order on reconnect; without it the host would hold the lock until its
TTL expired, up to five minutes. Releases coalesce per file, and the queue is bounded at
200 entries.

### `POST /api/coord/heartbeat` · `requireRoomMember`

`{ agentId, file?, workspaceId }` → `{ ok: true, renewed: <count> }`. Omit `file` to renew
every lock this agent holds in the workspace.

Heartbeats are deliberately **not** queued when the tunnel is down: a heartbeat asserts
liveness *now*, so replaying a stale one would revive a lock the host has already expired.

### `POST /api/coord/release-all` · `requireRoomMember`

`{ agentId, workspaceId }` → `{ released: [files] }`.

### `POST /api/coord/read` · `requireRoomMember`

Records that files were read. Never blocks, never denies, never fails.
`{ agentId, files, workspaceId, holder }` → `{ ok: true, files }`. Emits an `activity`
SSE event and broadcasts to the room.

### `GET /api/coord/status`

The raw lock table, optionally scoped by `?projectId`.

### `GET /api/locks` · `requireRoomMember`

`{ locks, reads, raw }` for `?projectId` (default: the selected project). `locks` is the
merged view — local plus mirrored-from-room — while `raw.locks` is only this machine's
table. Errors are swallowed into empty arrays rather than a 500.

### `GET /api/locks/stream`

Server-sent events. Emits the same `{ locks, reads, raw }` payload immediately and again
on every lock-table or room-mirror change.

### `POST /api/claim` · `POST /api/release` · `POST /api/release-all`

Unguarded direct access to the local lock table, with no room forwarding, no
sanitization and no collision accounting. Intended for local tooling and tests; prefer
`/api/coord/*`.

### `POST /api/heartbeat`

Direct `lockTable.heartbeat(body)`.

---

## Events and workspace

### `GET /api/events`

Server-sent events, optionally scoped by `?projectId`. Registers presence for the caller
(identified by the `x-relay-user` header or the session login) and deregisters on
disconnect. Event names include `locks`, `presence`, `activity`, `history`, `agents`,
`projects`, `graph`, `central` and `rewind`.

### `POST /api/ensure-workspace`

`{ workspacePath }` → registers the workspace if new; `{ ok: true, project }`.
**400 `workspace_path_required`** otherwise. Hooks call this fire-and-forget.

### `POST /api/ingest-stop`

Called by every stop hook. Syncs transcripts, falls back to harvesting the supplied
messages and edits when the transcript yields nothing, pushes room history and republishes
the graph.

```jsonc
{
  "workspacePath": "/home/ana/repo",
  "agentId": "Claude Code:ana-laptop:sess_9f3a",
  "agent": "Claude Code",
  "sessionId": "sess_9f3a",
  "transcript_path": "/home/ana/.claude/projects/…/sess.jsonl",
  "messages": []
}
```

### `POST /api/flush-file`

`{ workspacePath, agentId, files }` (or `file`) → computes a patch per file and fans it
out. **404 `no_local_repo`** if the path is not a registered project.

### `POST /api/flush-owned`

`{ workspacePath, agentId }` → flushes every file this agent currently holds a lock on.

### `POST /api/handshake` · `POST /api/connect`

Agent lifecycle for Mission Control. `handshake` marks an agent handshaking and writes a
token to `.relay/.handshake_<agent>`; `connect` marks it connected and starts the
workspace watcher.

### `GET /api/memory`

The whole `memory.json` for `?projectId`.

---

## Rooms

### `GET /api/room`

`{ room: publicRoom(...) }` — safe to serve through the tunnel.

### `POST /api/room/share`

Starts (or reuses) the ngrok tunnel and becomes host. **409 `already_guest`** if this
machine is already a guest somewhere.

### `POST /api/room/hello` · `requireRoomMember`

A guest announcing itself. Refreshes the roster and returns the current members.

### `POST /api/room/invite` · `requireLocal`

`{ login }` → **201** `{ ok, invite, code, link, collaborator, warning, room }`.

The code is shown **once**; only its SHA-256 is stored. Default lifetime is seven days.
Inviting a non-collaborator warns but does not block — the same check runs again at redeem
time, and that is what decides admission.

### `GET /api/room/invites` · `requireLocal`

`{ invites, open }`. Invite views never include the code or its hash.

### `POST /api/room/invites/:id/revoke` · `requireLocal`

Marks the invite revoked. **404** if unknown, **409 `not_hosting`** if there is no room.

### `POST /api/room/kick` · `requireLocal`

`{ login }` → revokes the member's token, revokes their outstanding invites, drops them
from the roster, and emits a notice. Their next control-socket frame closes with
`4401 membership_revoked`.

### `POST /api/room/redeem`

**The one room route a non-member may call.** Success mints the member token every other
room request requires.

```jsonc
{ "user": { "login": "bo", "name": "Bo", "avatarUrl": "…" },
  "code": "rli_…",              // or:
  "proofGistId": "…" }
```

For an invite-only room the caller must present either a valid invite code, or a GitHub
gist proving control of the claimed account against the room's `roomId` and `nonce`. The
invite must be pending (or previously accepted by the same login, for a rejoin) and
addressed to that login — a forwarded link is not a key. The login must also be a
collaborator on the repository.

**200** `{ ok, token, roomId, members, hostProjectId, hostWorkspacePath, hostLogin, project }`
· **403** with a specific reason: `invite_required`, `invite_invalid`, `invite_revoked`,
`invite_expired`, `invite_already_used`, `invite_wrong_user`, `not_a_collaborator`.

### `POST /api/room/join` · `POST /api/room/leave`

This machine joins a room by invite link, or leaves the room it is in. On leave, a guest
says goodbye to the host first so the roster flips it offline; a host stops the tunnel
watch and republishes its discovery signal as no longer live. Either way the host sockets
are torn down and the room file is cleared.

### `GET /api/room/members` · `requireRoomMember`

`{ members }` with `online` computed as *seen within 45 seconds*.

### `POST /api/room/bye` · `requireRoomMember`

`{ login }` → drops the member from the roster and emits a notice. A polite disconnect,
not a kick — no tokens are revoked.

### `GET /api/room/state` · `requireRoomMember`

The host's aggregate for guests: `chats`, `timeline`, `activity`, `edits`, `agents`,
`stats`, `hostLogin`, `lastTranscriptSyncAt`. Accepts `?projectId` and `?exclude=<login>`.

### `POST /api/room/history` · `requireRoomMember`

A member publishing its own transcript snapshot. Body limit **32 MB**. A member may only
publish under its own authenticated login.

### `POST /api/room/adopt`

`{ url }` → adopt an externally created tunnel (for example one you started yourself with
`ngrok http 3001`) as this machine's room URL.

### `GET /api/room/discover` · `requireLocal`

Open rooms discovered for this repository via the gist signalling channel.

### `GET /api/snapshot` · `requireRoomMember`

Working-tree snapshot. By default, patches for the dirty files; with `?full=1` the whole
tree, which is what a guest without a prior clone needs.

Scoped by `?projectId` or `?path`, defaulting to the selected project.
**404 `no_local_repo`** when there is none.

### `POST /api/patches` · `requireRoomMember`

`{ patch, remoteUrl, name, pathName, workspaceId }` → accepts a peer's patch, applies it
if appropriate, and relays it onward.

### `POST /api/push` · `POST /api/pull`

Behind `relay push` and `relay pull`. `pull` requires a room (**400 `not_in_a_room`**),
is a no-op on a host, and answers **502 `unreachable`** when the host cannot be reached.

### `POST /api/ask`

Compiles the `/relay ask` brief: syncs transcripts, pulls room history if a guest, merges
peer views, and returns `{ ok, written, markdown, data }`. Unless `write: false` is
passed, the markdown is also written to `<repo>/.relay/relay_ask.md`.

---

## Notices

`requireLocal` on all four.

| Route | Purpose |
|---|---|
| `GET /api/notices` | List notices and the unread count |
| `POST /api/notices/read-all` | Mark all read |
| `POST /api/notices/:id/read` | Mark one read |
| `POST /api/notices/dismiss` | Dismiss by id or key |

---

## MCP over HTTP

### `POST /mcp` · `requireRoomMember`

JSON-RPC 2.0, stateless, single message or batch. Remote callers get `readOnly: true` and
see only the nine read-only tools. A failed tool becomes a JSON-RPC error object
(`code: -32000`), never an HTTP 500 — a 500 would make the client drop the connection. A
batch containing only notifications answers **202** with an empty body.

### `GET /mcp` → **405 `streaming_not_supported`**
### `DELETE /mcp` → **405 `stateless_no_sessions`**

Both are optional in the MCP spec; a client that gets 405 simply stops asking.

See the [MCP reference](./MCP.md).

---

## Central

All `requireCentral`. A JSONL event store for cross-project context, separate from the
room mechanism.

| Route | Purpose |
|---|---|
| `POST /api/central/projects` | Create a project *(admin only)* |
| `GET /api/central/projects` | List projects *(admin only)* |
| `GET /api/central/projects/:id` | Fetch one |
| `POST /api/central/projects/:id/events` | Append an event; emits a `central` SSE event |
| `GET /api/central/projects/:id/events` | List events (`?since`, `?limit`, `?kind`) |
| `GET /api/central/projects/:id/context` | Compiled JSON context from the last 1000 events |
| `GET /api/central/projects/:id/changes` | The last 200 `change` events |
| `GET /api/central/projects/:id/decisions` | Decisions |
| `GET /api/central/projects/:id/tasks` | Tasks |

Non-admin credentials may only address their own project; anything else is
**403 `project_mismatch`**.

---

## WebSockets

### `/ws/control` — lock RPC

Frames: `{ type: "rpc", id, op, body }` where `op` is `claim`, `release`, `heartbeat`,
`release-all` or `read`. Replies are `{ type: "rpc-ok", id, result }` or
`{ type: "rpc-err", id, error }`. Also handles `ping`/`pong` and `join` (which replies
with a `locks` frame).

Limits: **64 KB** per frame (`4413 frame_too_large`) and **60 RPCs per second** per socket
(`rate_limited`). Server pings every 12 s.

### `/ws/patches` — patch fan-out

Frames: `patch`, `history`, `join`, `ping`/`pong`. On connect a host greets the socket
with a `hello` frame carrying the current room state, so a joining board is never blank
until the next lock change. Server pings every 15 s.

**Both sockets:** identity is decided once, at the handshake, from the
`x-relay-room-token` header or a `token` query parameter, and is never re-read from a
frame. A frame that arrives after the member is kicked, or after the room changes, closes
the socket. Close codes: `4401 not_a_member` / `membership_revoked`, `4403 not_hosting`,
`4413 frame_too_large`.

---

## Coordinator HTTP surface

The coordinator binds an ephemeral port on `127.0.0.1`, published in
`coordinator-state.json`. It is the fallback the hook client uses when the API is
unreachable, and it is unauthenticated — it is loopback-only by construction.

| Route | Purpose |
|---|---|
| `GET /health` | `{ ok, port, uptime, workspacePath }` |
| `POST /claim` | Claim, including soft-block warnings. 200 or 409 |
| `POST /release` · `POST /release-all` | Release |
| `POST /heartbeat` | Renew |
| `POST /escalate` | Re-register a batch of locks after a presence escalation |
| `POST /presence` | `{ workspaceId, userId, action }` join/leave |
| `GET /status` | The lock table plus uptime |
| `GET /stream` | SSE of the lock table on every change |
| `POST /graph` · `GET /graph` | Ingest and read the cross-workspace supergraph |
| `POST /patch` | Emit a `patch` event on the lock table |
