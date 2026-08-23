# Rooms and teams

A **room** puts several machines on one lock table. One member hosts; everyone else is a
guest. There is no Relay server anywhere — the host's own laptop is the server, reached
over an ngrok tunnel.

---

## Roles

| | Host | Guest |
|---|---|---|
| Owns the lock table | Yes — it *is* the shared mutex | No; mirrors the host's |
| Reached at | Their ngrok tunnel | Their own `127.0.0.1:3001` |
| Manages invites and kicks | Yes | No (`403 host_only`) |
| `relay pull` | No-op — already has the tree | Fetches the host's dirty files |
| Own hooks route through the tunnel | **No** — the host is the coordinator | Yes, via the control socket |

A host never routes its own hooks out through its tunnel and back. That would add a full
internet round trip to every claim and stall the agent whenever the tunnel hiccups.

---

## Hosting

```bash
relay login
relay serve
```

Then Mission Control → **Team** → **Share**.

Relay looks for an existing ngrok tunnel on the local inspector (`127.0.0.1:4040`) and
reuses it; only if there is none does it spawn `ngrok http <port>`. It never stacks
processes, and a failed probe of the public URL is not on its own a reason to spawn — the
inspector flapping after a laptop sleep is normal, and killing the only tunnel over it was
what kept ngrok dying.

If ngrok is installed but has no authtoken you will get a hint pointing at
[dashboard.ngrok.com](https://dashboard.ngrok.com/get-started/your-authtoken). You can
also run `ngrok http 3001` yourself and adopt the URL via `POST /api/room/adopt`.

Hosting is remembered. On the next `relay serve`, a host resumes its room automatically and
re-establishes the tunnel.

## Inviting

Team tab → **Invite** next to a teammate, or:

```http
POST /api/room/invite   { "login": "bo" }
```

You get back a **link** containing a single-use code addressed to that GitHub login. The
code is shown once; only its SHA-256 is stored in `room.json`, so a leaked room file
cannot be replayed to rejoin.

Invites expire after **seven days** by default, and expired ones are pruned whenever a new
invite is created. A pending invite can be revoked from the Team tab.

Inviting someone who is not a repository collaborator **warns but does not block** — you
may be about to add them. The collaborator check runs again at redeem time, and that is
what actually decides admission.

## Joining

```bash
relay login
relay serve
# paste the host's invite link on the Team tab
relay pull
```

`relay pull` takes the host's current working state. If you have no clone at all, the join
flow fetches `GET /api/snapshot?full=1` — the whole tree, not just the dirty files.

Once joined, your agents claim against the host's table automatically. There is nothing
further to configure.

---

## The credential model

Two credentials with different lifetimes. Only hashes are ever written to disk.

| | Invite code (`rli_…`) | Member token (`rlm_…`) |
|---|---|---|
| Issued by | The host, to one named login | The host, at redemption |
| Uses | Single | Every request, for the life of the room |
| Expires | 7 days by default | When revoked, or the room ends |
| Stored as | SHA-256 in `room.json` | SHA-256 in `room.json`; plaintext only in the member's own room file |

Both are compared with `crypto.timingSafeEqual`.

### Redemption

`POST /api/room/redeem` is the one room route a non-member may call. For an invite-only
room the caller must present **either**:

- a valid invite code — pending, not revoked, not expired, not already used, and addressed
  to the login being claimed (a forwarded link is not a key); **or**
- a `proofGistId`: a GitHub gist proving control of the claimed account, verified against
  the room's `roomId` and `nonce`.

Then the login must be a collaborator on the repository. Only after all of that is a
member token minted.

Failures are specific: `invite_required`, `invite_invalid`, `invite_revoked`,
`invite_expired`, `invite_already_used`, `invite_wrong_user`, `not_a_collaborator`.

### Presenting the token

The `x-relay-room-token` header, an `Authorization: Room <token>` header, or a `token`
query parameter. Hooks, the coordinator client, the lock mirror and the control socket all
send it automatically.

### Open rooms

A room with `open: true` skips invite checking entirely — anyone who learns the tunnel URL
can join. Rooms are discoverable per-repository through a gist signalling channel
(`GET /api/room/discover`), which is how "open rooms" appear in Mission Control for a repo
you have registered.

---

## What a member can and cannot do

A guest gets full read access to the room's context and full write access to the **lock
table** — that is the point. What it cannot do:

- **Claim as someone else.** The host appends the authenticated login to the incoming
  agent ID and overwrites `holder.login`. A member therefore cannot release a teammate's
  lock and edit the file underneath them.
- **Write through the room MCP endpoint.** `POST /mcp` marks remote callers read-only and
  does not even advertise the write tools.
- **Publish another member's history.** `POST /api/room/history` files the snapshot under
  the authenticated login, not the one in the frame.
- **Manage the room.** Invite, revoke, kick and notice routes are `requireLocal`.
- **Flood the host.** The control socket caps frames at 64 KB and RPCs at 60/second.

Identity on both WebSockets is decided once at the handshake and never re-read from a
frame, so a kicked member cannot keep talking — the next frame closes the socket with
`4401 membership_revoked`.

---

## Removing people, and leaving

```http
POST /api/room/kick   { "login": "bo" }     # host, local only
```

Revokes the member token, revokes their outstanding invites, drops them from the roster
and emits a notice. They stay on the GitHub collaborator list — this removes them from the
room, not from the repository.

`POST /api/room/leave` ends this machine's participation. A guest says goodbye to the host
first, so the roster flips it offline immediately; a host stops watching its tunnel and
republishes its discovery signal as no longer live, which ends the room for everyone.
Either way the host sockets are torn down and the local room file is cleared.

`POST /api/room/bye` is the polite variant a guest sends to the host on disconnect: it
drops them from the roster without revoking anything, so they can rejoin.

Members go **offline** on the board after 45 seconds without a heartbeat.

---

## Working state between machines

| | |
|---|---|
| `relay push` | Fan out every dirty working-tree file as patches |
| `relay pull` | Apply the host's current dirty files onto this clone |
| Automatic | Post-tool and stop hooks flush finished files; a filesystem watcher covers hand edits |

Patches carry a Lamport clock, are buffered until their predecessors arrive, transformed
pairwise, and never applied when the content already matches disk. Full details in
[Sync and patches](./SYNC.md).

A patch for a file another member is actively holding is withheld rather than raced onto
their disk.

---

## When the host disappears

Laptops close, tunnels expire, VPNs change. Relay degrades in defined steps:

1. **The coordinator client marks the room down** for 30 seconds after a failed call, so
   hooks stop paying a full timeout on every claim, heartbeat and release.
2. **Claims fall back** to the local lock table. This is a last resort, not the shared
   mutex — coordination across machines is genuinely lost until the host returns.
3. **Reads answer from the last snapshot.** MCP tools report `source: "local_snapshot"`
   with a `peer_snapshot_age_ms` so you can tell how stale the answer is.
4. **The board says so.** The dashboard carries `hostReachable` and `lastHostContactAt`,
   so "the host is not answering" is distinguishable from "nobody is editing" — which
   otherwise look identical from a guest's side.
5. **Reconnection is automatic.** A guest re-looks-up the host's current tunnel and
   reconnects both sockets when it comes back.

`relay doctor` walks exactly this chain. See [Troubleshooting](./TROUBLESHOOTING.md).

---

## Sharing read-only context

Anyone can read the room's context — chat history, recent edits, locks, conflicts — from
any MCP client, on a machine with no Relay installed:

```bash
relay mcp-url    # prints a ready-to-paste mcpServers block
```

The endpoint is read-only for everyone off the host machine. See the
[MCP reference](./MCP.md).
