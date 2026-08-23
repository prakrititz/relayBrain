# Relay documentation

Relay is a coordination layer for AI coding agents. It sits underneath Cursor, Claude Code,
Codex, GitHub Copilot CLI and Google Antigravity, and gives every agent on a repository —
on your machine and on your teammates' — one shared lock table, one dependency graph, one
patch stream and one board.

If you are new here, read [Quickstart](./QUICKSTART.md) first. If you are trying to
understand how it works, start at [Architecture](./ARCHITECTURE.md).

---

## Guides

| Document | What it covers |
|---|---|
| [Quickstart](./QUICKSTART.md) | Get a solo workspace coordinating in about five minutes. |
| [Installation](./INSTALLATION.md) | Requirements, install methods, attaching repositories, what gets written where. |
| [Concepts](./CONCEPTS.md) | The vocabulary: workspace, project, agent ID, lock, room, patch. Read this once. |
| [Rooms and teams](./ROOMS.md) | Hosting a room, invites, member tokens, joining, kicking, leaving. |

## Reference

| Document | What it covers |
|---|---|
| [CLI reference](./CLI.md) | Every `relay` command, its flags, output and exit codes. |
| [HTTP API reference](./HTTP-API.md) | Every endpoint on the API server and the coordinator, with auth rules. |
| [MCP reference](./MCP.md) | The Relay MCP server, its fifteen tools, and the read-only room endpoint. |
| [Hooks reference](./HOOKS.md) | The hook contract per agent, payload handling, and the response dialects. |
| [Configuration](./CONFIGURATION.md) | Environment variables, ports, config files and on-disk layout. |

## Internals

| Document | What it covers |
|---|---|
| [Architecture](./ARCHITECTURE.md) | Process model, the two planes, and how a single edit flows end to end. |
| [Locking](./LOCKING.md) | The lock table, TTLs, ownership, reads, and dependency-graph soft locks. |
| [Sync and patches](./SYNC.md) | Patch format, Lamport ordering, operational transform, transcript harvesting. |

## Operations

| Document | What it covers |
|---|---|
| [Troubleshooting](./TROUBLESHOOTING.md) | `relay doctor`, the empty-board problem, tunnel failures, hook debugging. |

---

## The one-paragraph version

One person runs `relay serve`. That process binds a local API on `127.0.0.1:3001`, an
ephemeral coordinator port that owns the lock table, and Mission Control on `:3002`. Every
agent on that machine has pre-tool, post-tool and stop hooks installed into its own config
format; the pre-tool hook claims a write lock before the agent's edit tool runs, and the
post-tool hook flushes the finished file and releases the lock. Teammates run their own
`relay serve` and join over an ngrok tunnel to the host, which makes the host's lock table
the single mutex for everyone. Working-tree state moves between machines as patches, never
as whole-project copies. Nothing is stored in a database and nothing leaves the machines
involved.
