# CLI reference

`relay <command> [args]`. With no command, or with `help`, `-h` or `--help`, the usage
summary is printed.

Every command below also works as `npm run relay -- <command>` from the repository root,
or as `npx relay <command>`.

---

## Identity

### `relay login`

Signs in with GitHub.

Tries the [`gh` CLI](https://cli.github.com) first. If that fails and `GITHUB_CLIENT_ID`
is set, falls back to the OAuth device flow, printing a verification URL and a user code
and then polling until you authorize.

```
signed in as Ana Ruiz (@ana) via GitHub CLI
```

If neither path is available it exits non-zero and tells you to install the `gh` CLI, or
to set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` and use **Continue with GitHub** in
Mission Control.

### `relay whoami`

Prints the signed-in user and the selected project. Exits **1** with
`not signed in — run relay login` when there is no session.

```
Ana Ruiz (@ana)
project prj_9c1f2a
```

### `relay logout`

Clears the local session. Always exits 0.

---

## Attaching repositories

### `relay clone <url> [dir]`

`git clone`, then register the checkout as a project, then install hooks, MCP config and
the relay-os instruction block.

```
cloned https://github.com/you/repo.git
workspace /home/ana/repo
registered repo (prj_9c1f2a)
```

### `relay add <path> [name]`

Attaches a repository that is already on disk. Same registration and installation as
`clone`, without the network step.

```
added /home/ana/repo as repo
```

### `relay init [path]`

Wires hooks, the Relay MCP server and the `/relay ask` instructions for every supported
agent in `path` (default: the current directory), installs the **global** hook
configuration in your home directory, and registers the path as a project.

Exits **1** if the path does not exist.

```
Relay initialized in /home/ana/repo
Hooks + MCP wired for Cursor, Claude Code, Codex, Copilot CLI, Antigravity.
Run `relay serve`, then say `/relay ask` in any agent — it calls MCP relay_room_brief.
```

See [Installation → What gets written](./INSTALLATION.md#what-gets-written) for the full
file list.

---

## Running

### `relay serve [--port N] [--no-ui]`

Starts the API server, the coordinator and — unless `--no-ui` is given — Mission Control.

| Flag | Effect |
|---|---|
| `--port N` | API port. Defaults to `RELAY_PORT`, then 3001. |
| `--no-ui` | Skip Mission Control; run API and coordinator only. |

Mission Control's port comes from `RELAY_UI_PORT` (default 3002) and is passed to the
child `next dev` process along with `NEXT_PUBLIC_RELAY_API` pointing at the API origin.
The UI is only started after `/api/health` answers, with a 30 s ceiling.

`relay serve` supervises both children: `SIGINT` or `SIGTERM` tears down the whole tree
(via `taskkill /t /f` on Windows), and if either child exits, the other is stopped too.

If Mission Control's dependencies are missing it prints
`Mission Control is not installed — run npm install` and exits 1. If the API never becomes
ready it prints `[relay] API did not become ready on <origin>` and exits 1. If the API
port is already bound, the API process reports the conflict and exits without touching the
running instance's coordinator state.

### `relay status`

Pretty-prints `GET /api/health` — version, coordinator port, whether a user is signed in,
and the public room view (role, url, host project). Exits **1** with
`offline — run relay serve` when the API is unreachable.

---

## Sharing work

### `relay push`

`POST /api/push`. Computes a patch for every dirty working-tree file and fans it out to
the room.

```
push 3 file(s)
  src/auth.ts
  src/routes.ts
  package.json
```

Prints `push: nothing to push` when the tree is clean.

### `relay pull`

`POST /api/pull`. Fetches the host's dirty files and applies them to this clone. Prints
the files applied, or `pull: nothing to pull`.

Requires a room — without one the API answers `not_in_a_room` and the CLI prints the hint
and exits 1. On a host it is a no-op: the host already holds the working tree.

Both commands print the API's `hint` or `error` and exit **1** on failure, and
`offline — run relay serve` if the API cannot be reached. Note that both target
`127.0.0.1:3001` directly and do not honour `--port` or `RELAY_PORT`.

---

## MCP

### `relay mcp-url`

Prints a ready-to-paste `mcpServers` block for this room's shared-context endpoint:

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

The endpoint is **read-only** for anyone off the host machine — it exposes the room's chat
history, recent edits, locks and conflicts to any MCP client, including one on a machine
with no Relay installed. Locks and every other write stay on each member's own relay.

Exits **1** when this machine is not in a room, and notes that locally your agents already
reach Relay over stdio with nothing to configure. Warns if you are a guest with no member
token on file.

---

## Diagnostics

### `relay doctor`

Walks the exact chain the Coordinator board depends on and names the broken link.

This exists because locks and the board are different subsystems: a hook claims straight
against the host over HTTP, while the board is fed by the lock mirror and SSE. "Locking
works but I see nothing" is a normal — and otherwise invisible — way for Relay to fail.

Checks, in order:

1. Local API answers on `127.0.0.1:<RELAY_PORT>`. If not, it stops here and exits 1.
2. A room is joined, and with what role and URL.
3. **Guest only:** `room.json` carries a `hostProjectId`. Without it the lock mirror never
   starts, so the board stays empty even while locks work.
4. **Guest only:** the host answers `/api/health` through the tunnel.
5. **Guest only:** the host answers `/api/locks` for the shared project, and how many
   locks it reports.
6. This machine mirrors those locks. Because the mirror polls on its own clock, this is
   retried for up to four seconds before anything is called broken.

It finishes by printing what the board would render, split into locks mirrored from the
room and locks claimed on this machine.

Run it **on the machine that sees nothing**.

See [Troubleshooting](./TROUBLESHOOTING.md) for what to do with each result.

---

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Not signed in, offline, path not found, unknown command, or a failed API call |

Unhandled errors print `err.message` and exit 1.
