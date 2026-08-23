# Concepts

Six terms carry most of the meaning in Relay. Everything else in the documentation assumes
these.

---

## Workspace

An absolute path to a repository checkout on one machine — `C:\work\api` or
`/home/ana/api`. The workspace path is the namespace for locks: every lock key is
`<normalized workspace>::<repo-relative file>`.

This matters more than it sounds. Two machines never agree on the path of "the same" repo,
so if each side used its own path, two agents editing `src/auth.ts` would land in two
different namespaces and the coordinator would arbitrate nothing while looking like it was
working. Relay solves this by rewriting a guest's workspace onto the **host's** workspace
path before the claim reaches the lock table — twice, in fact: once on the way out of the
guest's coordinator client, and again on the host for any request carrying a member token.

Workspace paths are normalized before comparison: backslashes become forward slashes,
trailing separators are dropped, comparison is case-insensitive, `file://` prefixes are
stripped and Windows drive letters are un-doubled.

## Project

A workspace that Relay has registered. A project has an `id` (`prj_…`), a `name`, a `path`
and, when detectable, a `remoteUrl`. The registry lives at
`~/.relay/data/registry.json`; per-project state lives under
`~/.relay/data/projects/<id>/`.

`relay add`, `relay clone` and `relay init` all create a project. A workspace can also be
registered implicitly: a hook posting to `/api/ensure-workspace` will register the
workspace it is running in.

Projects are per-machine. A room shares exactly one project, and each member has their own
project row pointing at their own clone.

## Agent ID

The identity Relay arbitrates against, formatted `label:host:session` — for example
`Claude Code:ana-laptop:sess_9f3a`.

- **label** — the product, detected from the hook payload's fingerprint rather than from
  the hook script's filename. (`.claude/settings.json` is read by Claude Code, by Cursor
  and by Copilot, so the filename is not evidence.)
- **host** — `os.hostname()`.
- **session** — the agent's own session or conversation id, or `local` when the product
  does not supply one.

Two agent IDs are the *same owner* when they share a host and either both name a real
session and those sessions match, or at least one session is unknown and the labels match.
That rule does two jobs at once: one editor firing two hook configs does not deadlock
against itself, and two concurrent turns of the *same* product are correctly treated as
two different owners.

When a claim arrives from a remote room member, the host appends the authenticated GitHub
login (`…@ana`) and stamps the holder's login. A member therefore cannot express a claim
as someone else, and so cannot release a teammate's lock.

## Lock

A TTL-based, auto-expiring exclusive write claim on one file in one workspace. Default TTL
is 15 s, clamped to the range 5 s – 300 s. A lock survives only as long as it is
heartbeated; the cleanup sweep runs every 5 s.

There are three related but distinct things on the board:

| | Blocks anyone? | Lifetime |
|---|---|---|
| **Write lock** | Yes — a second owner is refused | TTL from last heartbeat (default 15 s) |
| **Read** | Never | 30 s, capped at 300 entries |
| **Released lock** | No, display only | 45 s, capped at 200 entries |

Reads are presence, not claims: observing a file cannot corrupt it, so a read is recorded
for the board and always allowed — including while someone else holds the write lock.
Released locks linger on the board because a pre-tool claim and its post-tool release can
be about 100 ms apart, and a board that only rendered live locks showed nothing at all.

See [Locking](./LOCKING.md) for the full state machine.

## Room

A shared coordination session across machines. One member is the **host**: their
`relay serve` is exposed through an ngrok tunnel and their lock table is the single mutex
for everyone. Every other member is a **guest** with their own local relay.

A room is identified by a `roomId` (`rlr_…`) and is described by `room.json`, written both
to `~/.relay/room.json` and to `<repo>/.relay/room.json`. Membership is proven with two
credentials — a single-use **invite code** and a long-lived **member token** — of which
only hashes are ever written to disk.

See [Rooms and teams](./ROOMS.md).

## Patch

The unit of working-tree state that moves between machines. A patch names one file and
carries its `sha256`, a `git diff` (or the first 4 KB of content when there is no diff),
the full content when the file is text and under 1 MB, and a **Lamport** counter for
ordering.

Patches, not project copies, are what `relay push` and `relay pull` move. They are ordered
by Lamport clock, buffered until their predecessors arrive, transformed pairwise, and
applied to disk only when the content actually differs from what is already there — that
last check is what stops two machines in a room from trading the same file forever.

See [Sync and patches](./SYNC.md).

---

## Two planes, and why they fail differently

Relay has a **control plane** (claims, releases, heartbeats — what actually arbitrates)
and a **view plane** (the lock mirror, SSE streams, the board). They are fed differently
and they fail differently.

A hook claims straight against the coordinator over loopback, and a guest's claim goes
over a small WebSocket RPC to the host. The board, meanwhile, is fed by a mirror that
polls on its own clock. So "locking works but Mission Control shows nothing" is a normal
and otherwise invisible failure mode — and precisely what `relay doctor` exists to
diagnose.

## Fail-open, on purpose

Every hook fails open. If the coordinator is unreachable, the claim falls back to an
exclusive lock file on disk (`wx` flag), and if even that fails the tool is allowed to
run. An agent must never be frozen by its coordination layer. The cost is that a hook
which fails silently leaves no trace — which is why `RELAY_HOOK_DEBUG=1` exists.

The one exception is Copilot CLI, whose hook contract is fail-*closed*: a non-zero exit
denies the tool call, so the allow path must always exit 0.
