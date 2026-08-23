# Sync and patches

Your teammate has their own filesystem, their own environment and their own agents. Relay
propagates **patches**, not whole-project copies.

---

## The patch

`computePatch()` in `backend/lib/patches.js` produces:

```jsonc
{
  "id": "patch_1a2b3c4d5e6f",
  "file": "src/auth.ts",          // always posix, repo-relative
  "agent": "Claude Code",
  "ownerLogin": "ana",
  "lamport": 42,
  "ts": 1755900000000,
  "binary": false,
  "sha256": "9f86d081…",           // of the file's bytes on disk
  "diff": "@@ -12,6 +12,9 @@ …",   // git diff, or first 4 KB of content
  "content": "…"                   // full text, only when text and < 1 MB
}
```

Rules that matter:

- **Binary detection** is a NUL-byte scan. A binary patch carries `replace: true`, no
  content, and is only ever recorded — `applyPatchToDisk` refuses it with
  `binary_sha_replace`, so binary files are never written by patch delivery.
- **Content is omitted** for files of 1 MB or more. Those patches record and display but
  do not apply.
- **`diff`** is `git diff -- <file>` with a 2 s timeout. If git produces nothing (a new
  untracked file, or no git at all), the first 4 KB of the content is used as the diff
  text so the board still has something to render.

---

## Lamport ordering

Each workspace has its own counter (`backend/lib/lamport.js`). `tick()` returns
`max(local + 1, incoming + 1)`, so a patch that arrives from a peer with a higher clock
pulls the local clock forward. That gives every machine a consistent total order without a
shared clock or a coordinator round trip.

Patches are inserted into memory with `insertOrdered`, sorted by `lamport` then by file
name so the ordering is deterministic when two patches share a clock value.

## The buffer and the drain

Incoming patches go into `memory.patchBuffer`. `drain()` walks it in Lamport order and
releases only a contiguous run:

- anything at or below `lastAppliedLamport` is discarded as already applied;
- from a cold start (`lastApplied === 0`) the first patch is accepted whatever its clock;
- after that, only `lastApplied + 1` is released, and everything beyond the gap is **held**.

So a patch that arrives out of order waits for its predecessor rather than being applied
early. Held patches are counted as `patchesDeferred`.

## Pairwise transform

Consecutive ready patches are checked with `transformPair()`:

- **Different files** — no interaction, both pass.
- **Binary** — ordered by Lamport, no content merge attempted.
- **Same file, overlapping hunks** — `{ ok: false, manual: true }`. The patch is *not*
  applied, and a `merge_flagged` collision is recorded with the file, reason and Lamport.
- **Same file, disjoint hunks** — ordered by Lamport and both applied.

Overlap is decided by parsing `@@ -n` headers out of the diff and comparing the line ranges
each patch touches. This is a pragmatic line-range test, not a full OT implementation —
its job is to refuse silently-wrong merges, not to resolve every one automatically.

## Applying to disk

`applyPatchToDisk()` writes `patch.content` to `<workspace>/<file>`, creating parent
directories as needed. Two guards:

- **Binary** patches are never written.
- **Identical content** is never rewritten. This is not an optimization — rewriting
  identical content still fires the filesystem watcher, which publishes a fresh patch with
  a new id straight back to the peer it came from. Two machines would then trade the same
  file forever at full CPU, because every hop legitimately looks like a new edit. Content
  equality is the only thing that terminates that loop.

---

## How patches move

### Automatically, as agents work

The post-tool hook calls `POST /api/flush-file`, which computes a patch for each finished
file and fans it out to every connected peer over `/ws/patches`. The stop hook calls
`POST /api/flush-owned`, which does the same for every file the agent still holds a lock
on.

A filesystem watcher (`backend/lib/watchWorkspace.js`) covers edits made outside an agent
— by you, in your editor.

### On demand

```bash
relay push    # POST /api/push  — fan out every dirty working-tree file
relay pull    # POST /api/pull  — fetch the host's dirty files and apply them
```

"Dirty" is `git status --porcelain -uall`, minus `.git`, `.relay`, `node_modules`,
`.next`, `dist` and `out`. `relay pull` is guest-only; on a host it returns
`{ ok: true, files: [], note: "host already has the working tree" }` because the host is
already holding the working tree.

### On join

`GET /api/snapshot?full=1` returns the whole tree rather than only the dirty files. A
guest joining without a prior clone needs it — the dirty-only payload would leave them
staring at an empty folder.

---

## Peer clash protection

`backend/lib/peerClash.js` decides whether an outgoing patch should be published at all.
A patch for a file another member currently holds a live lock on is held back rather than
raced onto their disk, and counted as `patchesBlocked` or `patchesSkipped`. This is the
patch-layer counterpart to the lock table: locks stop two agents editing at once, peer
clash stops a patch landing under an agent that is mid-edit.

---

## Rewind

```http
POST /api/projects/:id/rewind   { "lamport": 37 }
```

Replays every recorded patch with `lamport <= 37`, keeping only the latest patch per file,
and writes those to disk. It answers with the files touched, the apply results and the
patches replayed, and emits a `rewind` SSE event.

Rewind is a working-tree operation on top of Relay's own patch log. It is not git, does
not touch git, and does not know about commits.

---

## Conflict detection

Separate from the transform layer, `detectConflicts()` reports files touched by **two or
more distinct agents within the last five minutes**, with a two-line summary of each edit.
This is the "conflicts" surface in Mission Control and the MCP tool
`relay_get_conflicts`. It is a report, not a gate.

---

## Transcript harvesting

Relay also unifies what the agents *said*, not just what they wrote.

On every stop hook, `POST /api/ingest-stop` triggers a transcript sync. Discovery looks in
each product's own location:

| Agent | Transcript location |
|---|---|
| Cursor | `~/.cursor/projects/<slug>/agent-transcripts/` |
| Claude Code | `~/.claude/projects/<slug>/` |
| Codex | `~/.codex/sessions/` |
| Copilot | VS Code `workspaceStorage` (`~/AppData/Roaming/Code/User/workspaceStorage`, `~/.config/Code/User/workspaceStorage`, `~/Library/Application Support/Code/User/workspaceStorage`) |
| Antigravity | `~/.gemini/antigravity-ide/brain`, `~/.antigravity/brain`, `~/AppData/Roaming/Antigravity IDE/brain`, `~/Library/Application Support/Antigravity IDE/brain` |

Cursor's directory is resolved by slug when possible, and otherwise by scanning candidate
directories and reading only the first 12 KB of each transcript to find one that mentions
the workspace — transcripts reach tens of megabytes, and reading them whole on a repeating
sweep stalled the event loop.

Parsed turns become `memory.history`, `memory.chats` and `memory.timeline`. Edits detected
in transcripts become `memory.edits`. Where a transcript yields nothing, `harvest()`
falls back to the messages the stop hook itself supplied.

In a room, each member pushes a snapshot of these arrays to the host
(`POST /api/room/history`, which accepts bodies up to 32 MB), and guests pull the host's
aggregate from `GET /api/room/state`. `mergeRoomViews()` stitches local and peer arrays
into one time-ordered view, tagging every row with its `ownerLogin` and a `mine` flag.
When the tunnel is down, a guest answers from the last snapshot it stored — stale, but the
difference between a degraded answer and no answer.
