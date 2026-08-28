# Contributing to Relay

Thanks for your interest. Relay is a coordination layer for AI coding agents — file locks,
dependency-aware locks, patch sync and one shared board across Cursor, Claude Code, Codex,
GitHub Copilot CLI and Google Antigravity.

Before changing anything substantial, skim [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Most of Relay's surprising decisions are load-bearing, and the code comments explain why.

---

## Getting set up

```bash
git clone https://github.com/prakrititz/relayBrain.git
cd relayBrain
npm install
npm link            # puts `relay` on your PATH
```

Node 20+ is required, matching the `engines.node` field in `package.json`. There is no database and no
hosted backend to configure.

Run it against a scratch repository rather than this one:

```bash
relay add /path/to/some/test/repo
relay serve
```

| Script | What it does |
|---|---|
| `npm run dev` | API + Mission Control together |
| `npm run dev:api` | API only |
| `npm run dev:ui` | Mission Control only |
| `npm start` | `node backend/server.js --port 3001` |
| `npm run coordinator` | The coordinator standalone, useful for lock-table work |
| `npm run relay -- <cmd>` | The CLI without linking |

---

## Where things live

| Area | Path | Read first |
|---|---|---|
| CLI | `cli/relay.js` | [docs/CLI.md](docs/CLI.md) |
| API server | `backend/server.js` | [docs/HTTP-API.md](docs/HTTP-API.md) |
| Lock table | `backend/coordinator/` | [docs/LOCKING.md](docs/LOCKING.md) |
| Dependency graph | `backend/lib/depGraph.js`, `treeSitterImports.js` | [docs/LOCKING.md](docs/LOCKING.md) |
| Patches and ordering | `backend/lib/{patches,ot,lamport}.js` | [docs/SYNC.md](docs/SYNC.md) |
| Rooms | `backend/lib/room*.js` | [docs/ROOMS.md](docs/ROOMS.md) |
| Hooks | `hooks/` | [docs/HOOKS.md](docs/HOOKS.md) |
| MCP | `backend/mcp/` | [docs/MCP.md](docs/MCP.md) |
| Dashboard | `mission-control/` | — |

---

## Workflow

1. Fork and branch. Use a descriptive name:
   `fix/lock-ttl-clamp`, `feat/worktree-isolation`, `docs/hook-payloads`.
2. Make focused changes. Small PRs get reviewed; large ones get stalled.
3. Verify locally (below).
4. Open a pull request against `main`, describing what changed and how you tested it.

---

## Verifying your change

There is no automated test suite yet, so verification is manual and specific to what you
touched. Say in the PR what you actually did.

**Any change**

```bash
npm install
relay serve
relay status
```

**Lock table or coordinator**

Run two agents against one repository and make one of them try to edit a file the other is
holding. Confirm the second is refused with a useful message, and that the lock disappears
after the TTL. `relay doctor` prints the table as the board would render it.

**Hooks**

```bash
export RELAY_HOOK_DEBUG=1
```

then run the agent and read `~/.relay/hook-debug.log`. A hook change is not verified until
you have confirmed the phases you touched appear there — `pre:claim`, `post:flush`,
`post:release`, `stop:release-all`. Test on **every** product you could have affected: the
five have four different response dialects, and getting one wrong fails silently.

**Rooms and patches**

You need two machines, or two clones with two `relay serve` instances on different ports.
Confirm a claim on one blocks the other, and that `relay push` / `relay pull` move files
in both directions.

**Mission Control**

`npm run dev` and check the board updates live as locks are claimed and released.

---

## Style

- Match the surrounding code. No new formatter, linter or framework in a PR that is
  about something else.
- **Comment the why, not the what.** Relay's existing comments explain the failure that
  motivated a decision — which product sends which payload shape, why readers do not block
  writers, why identical content is never rewritten. That is the standard; a PR that
  changes such behaviour should update the comment that explains it.
- Keep hook code defensive and **fail-open**. An agent must never be frozen by its
  coordination layer. The one exception is Copilot CLI, whose contract is fail-*closed* —
  the allow path there must exit 0.
- Use the project's vocabulary: *workspace*, *project*, *room*, *host* / *guest*, *lock*,
  *patch*, *Mission Control*, *MCP*. See [docs/CONCEPTS.md](docs/CONCEPTS.md).
- Never log or serialize a secret. Invite codes and member tokens are stored only as
  hashes, and `publicRoom()` exists to keep them out of responses — do not route around it.

---

## Documentation

If your change affects installation, agent integration, the API surface or user workflow,
update the docs in the same PR:

| You changed | Update |
|---|---|
| A CLI command or flag | `docs/CLI.md`, and the `help()` text in `cli/relay.js` |
| An endpoint | `docs/HTTP-API.md` |
| An MCP tool | `docs/MCP.md` |
| Hook behaviour or a matcher | `docs/HOOKS.md` |
| Lock or dependency-graph semantics | `docs/LOCKING.md` |
| Patch format or ordering | `docs/SYNC.md` |
| Room, invite or auth behaviour | `docs/ROOMS.md` |
| An environment variable or a file path | `docs/CONFIGURATION.md` |
| A new failure mode | `docs/TROUBLESHOOTING.md` |

Documentation-only PRs are welcome on their own.

---

## Reporting issues

Include:

- What you were trying to do.
- What happened, and what you expected.
- `relay status` and `relay doctor` output.
- Node version and OS.
- For hook problems: the relevant lines from `~/.relay/hook-debug.log` with
  `RELAY_HOOK_DEBUG=1` set. A `pre:no-files` line records the payload keys the path
  extractor did not recognise — that is exactly the report that lets us fix it.

For a security issue — anything touching invite codes, member tokens, or what a room
member can reach on a host — please report it privately to the maintainers rather than
opening a public issue.

---

## Licence

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
