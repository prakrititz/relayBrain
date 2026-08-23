# Troubleshooting

Start with:

```bash
relay status     # is the API up, and what room is this machine in
relay doctor     # walk the chain the board depends on
```

Run `relay doctor` **on the machine that sees the problem**.

---

## The board is empty but locking works

This is the single most common confusion, and it is not a bug in the usual sense: locks
and the board are **different subsystems**. Hooks claim straight against the coordinator
(or, for a guest, over the control socket to the host). The board is fed separately by a
lock mirror that polls on its own clock, plus SSE.

So "my agents are being blocked correctly, but Mission Control shows nothing" is a real
and otherwise invisible state.

`relay doctor` distinguishes them. Read its output in order:

| Line | Meaning | Fix |
|---|---|---|
| `BROKE no local API` | Nothing is running here | `relay serve` |
| `no room joined on this machine` | Solo — the board shows only local agents | Nothing to fix, unless you meant to join |
| `BROKE room.json has no hostProjectId` | The lock mirror never starts, so the board stays empty while locks work fine | Re-join with the invite link |
| `BROKE cannot reach the host` | Tunnel down or host asleep | See *the host is unreachable* below |
| `BROKE host refused /api/locks` | Invite-only room and no member token stored | Re-join with the invite link |
| `the host holds locks but this machine mirrors none` | The mirror is not committing its polls | Restart `relay serve` here — and if it comes back, that is worth reporting |
| `Nothing is locked anywhere right now` | An empty board is correct | Have someone start an agent edit and re-run |

`doctor` waits up to four seconds before calling the mirror broken, because a lock claimed
a moment ago has not necessarily polled through yet.

---

## Agents are not being blocked at all

Work down this list.

**1. Is `relay serve` running?** Everything is fail-open by design. With no server, hooks
fall back to filesystem locks and then to allowing the tool. `relay status` answers this.

**2. Are the hooks installed for *that* agent?** Check the repository for the file your
agent reads:

```
.claude/settings.json        Claude Code
.cursor/hooks.json           Cursor
.codex/hooks.json            Codex
.github/hooks/relay-os.json  Copilot CLI
.agents/hooks.json           Antigravity
```

Missing or stale? Run `relay init` in the repository, then **restart the agent** — none of
them re-read hook configuration mid-session.

**3. Did you move or rename the Relay checkout?** Hook commands are absolute paths into
`hooks/`. Re-run `relay init`.

**4. Turn on hook debugging.**

```bash
export RELAY_HOOK_DEBUG=1
# run the agent, then:
tail -f ~/.relay/hook-debug.log
```

- **No lines at all** — the hook is not firing. The config is wrong, or the agent was
  started before the config was written, or the tool the agent used is not in the matcher
  list.
- **`pre:no-files`** — the hook fired but found no path in the payload. The line records
  the payload's top-level keys and the first eight raw paths. This is the case worth
  filing an issue about: paste those keys.
- **`pre:claim` with `allowed: true`** — the claim succeeded. Working as intended; check
  the board next.
- **`pre:claim` with `via: "fail-open"`** — no coordinator was reachable within the 3 s
  budget.

**5. Watch the server side.** The terminal running `relay serve` prints a `[relay-hook]`
line for every hook request, with status, duration, workspace, agent and files. No lines
means the hook never reached the API.

---

## Two agents edited the same file anyway

**Check the workspace paths match.** Locks are namespaced by absolute workspace path. Two
agents started in different roots — a subdirectory, a different drive letter, a symlinked
path — land in different namespaces. `~/.relay/hook-debug.log` records the workspace each
hook resolved; compare them.

**Check the agent IDs.** In a room, a peer's claim should carry `@<login>`. Two turns of
the same product in the same session are correctly one owner; two turns with different
session ids should be two owners. `relay doctor` prints the holder of every lock it can
see.

**Check the timing.** The default TTL is 15 seconds. An agent whose edit tool took longer
than that without heartbeating lost its lock legitimately. The pre-tool hook heartbeats
once immediately after claiming; a very long single tool call can still outlive its lock.

**Remember that reads never block.** If one agent has a *read* recorded on the file, that
is presence, not a claim, and it will not stop a writer.

---

## The host is unreachable

Symptoms: guests see `hostReachable: false` on the board, `relay doctor` reports
`cannot reach the host`, MCP tools answer with `source: "local_snapshot"`.

1. **On the host, is `relay serve` running?** Tunnels do not survive the process.
2. **Is ngrok alive?** Check `http://127.0.0.1:4040` on the host. Relay reuses an existing
   tunnel and only spawns one when there is none.
3. **Does ngrok have an authtoken?** Sign up at
   [dashboard.ngrok.com](https://dashboard.ngrok.com/signup), then
   `ngrok config add-authtoken <token>`, keep `relay serve` running, and click **Share**
   again.
4. **Did the URL change?** Free ngrok URLs rotate. A guest re-looks-up the host's current
   tunnel automatically, but re-joining with a fresh invite link is the certain fix.
5. **Do it by hand if you prefer.** Run `ngrok http 3001` yourself and adopt the URL with
   `POST /api/room/adopt`.

While the host is down, guests fall back to their local lock tables. Coordination across
machines is genuinely lost until it returns — but agents keep working, and the coordinator
client marks the room down for 30 seconds at a time so hooks are not paying a full timeout
on every call.

---

## `relay serve` will not start

**`port 3001 is already in use`** — another `relay serve` is running. Relay exits without
touching the live instance's coordinator state, which is deliberate: overwriting it would
degrade every hook on the machine to filesystem-only locking. Stop the other instance, or
use `--port`.

**`Mission Control is not installed — run npm install`** — `mission-control`'s
dependencies are missing. Run `npm install` at the repository root (it is an npm workspace,
so the root install covers it), or use `relay serve --no-ui`.

**`API did not become ready`** — the API did not answer `/api/health` within 30 seconds.
Look at the API output above the message; a tree-sitter or registry failure at startup
shows there.

---

## Sign-in problems

**`not signed in — run relay login`** — no session. Run `relay login`.

**`relay login` fails** — it needs the `gh` CLI and an authenticated session
(`gh auth login`). Without it, set `GITHUB_CLIENT_ID` for the device flow, or
`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` and use **Continue with GitHub** in Mission
Control.

**`oauth_not_configured` (501)** — the browser flow needs both variables set before
`relay serve` starts.

---

## Joining a room fails

The redeem route answers with a specific reason. Match it here:

| Error | Meaning |
|---|---|
| `invite_required` | The room is invite-only and you presented neither a code nor a gist proof |
| `invite_invalid` | The code does not match any invite |
| `invite_revoked` | The host revoked it |
| `invite_expired` | Past its seven-day default lifetime |
| `invite_already_used` | Single use, and already redeemed |
| `invite_wrong_user` | Issued to a different login — a forwarded link is not a key |
| `not_a_collaborator` | Your login is not a collaborator on the repository |
| `not_hosting` | The URL you used is not currently hosting a room |
| `already_guest` | You are trying to host while already a guest somewhere; leave first |
| `not_a_member` (401) | Your member token is missing or was revoked |

---

## Patches are not moving

**Nothing is dirty.** `relay push` reports `nothing to push` when
`git status --porcelain -uall` is empty, minus `.git`, `.relay`, `node_modules`, `.next`,
`dist` and `out`.

**You are the host.** `relay pull` is a no-op on a host — it already holds the working
tree.

**The file is binary.** Binary patches are recorded and displayed but never written to
disk.

**The file is 1 MB or larger.** Content is omitted above that threshold, so the patch
records but does not apply.

**A patch is waiting for its predecessor.** Ordering is strict: a patch whose Lamport
clock is not the next one is held in `patchBuffer` until the gap closes. Check
`GET /api/projects/:id/patches` for `lastAppliedLamport`, and the `patchesDeferred`
counter.

**The merge was flagged.** Two patches with overlapping hunks on the same file are refused
rather than merged wrongly, and counted as `mergesFlagged`. Resolve by hand.

**A peer holds the file.** Patches for a file another member is actively editing are
withheld rather than raced onto their disk — `patchesBlocked` / `patchesSkipped`.

---

## `/relay ask` does nothing

`/relay ask` is a project convention, not a built-in command, and not something you run in
a terminal. The agent is instructed by the relay-os block to call the MCP tool
`relay_room_brief`.

- **The agent says the `relay` MCP server is missing** — run `relay add .` or
  `relay init`, then restart the agent.
- **The agent treats it as chat** — the relay-os block is missing from that agent's
  instruction file. `relay init` writes it into `AGENTS.md`, `CLAUDE.md`, `.cursorrules`,
  `.cursor/rules/relay.mdc` and `.github/copilot-instructions.md`.
- **The brief is stale** — the tool syncs transcripts on every call, but a guest whose
  tunnel is down answers from its last snapshot. The returned `room.source` tells you
  which: `host`, `local_snapshot` or `solo`.

---

## The dependency graph looks wrong

**Nothing is parsed.** Only these extensions are walked: `.ts .tsx .js .jsx .mjs .cjs .py
.go .rs .java .cs .cpp .cc .cxx .h .hpp .php .rb`. `node_modules`, `.git`, `.next`, `out`,
`dist`, `coverage`, `.relay` and every dot-directory are skipped.

**An edge is missing.** Dynamic imports and config-driven wiring are invisible to a static
parser. They are reported in `unresolvable` with reason `dynamic` or `missing`. Add the
edge by hand in `.relay/deps.json`.

**Too few or too many warnings.** Adjust `lockDepth` in `.relay/deps.json` (or
`RELAY_LOCK_DEPTH`). Remember these are soft blocks — they warn, they never refuse.

**The graph is stale.** `GET /api/projects/:id/graph` rebuilds; the dashboard uses a cached
graph. `POST /api/projects/:id/sync` republishes it.

---

## Locks pointing at a drive that no longer exists

If a workspace's `.relay` directory cannot be created — a missing drive letter, an
unplugged disk, a workspace path recorded on another OS — Relay falls back to a hashed
subdirectory under `~/.relay/locks/` rather than dropping the claim. Locks still arbitrate;
they are just not stored next to the repository. Re-register the project at its real path
(`relay add <path>`) to restore the normal location.

---

## Still stuck

Collect this before filing an issue:

```bash
relay status
relay doctor
node --version
```

Plus, with `RELAY_HOOK_DEBUG=1` set, the relevant lines from `~/.relay/hook-debug.log` —
particularly any `pre:no-files` line, which records the payload keys the extractor did not
recognise.
