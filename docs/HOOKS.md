# Hooks reference

Hooks are how Relay gets underneath an agent without the agent knowing. Four phases, five
products, one shared implementation.

---

## The four phases

| Phase | Script suffix | Does |
|---|---|---|
| **Pre-tool** | `-pre-tool.js` | Claims a write lock (15 s TTL) before the edit tool runs. Can deny. |
| **Pre-read** | `-pre-read.js` | Records that a file was read. Never blocks, never denies. |
| **Post-tool** | `-post-tool.js` | Flushes the finished file as a patch, then releases the lock. |
| **Stop** | `-stop.js` | Flushes everything owned, releases all locks, ingests the transcript. |

The twenty files in `hooks/` are thin shims. Each calls into `hooks/relay-hook-lib.js`
with a declared mode — and the declared mode is only a fallback, because the library
re-detects the product from the payload.

---

## Which product is actually running?

The script's filename cannot answer this. `.claude/settings.json` is read by Claude Code,
by Cursor (which maps the Claude-style config onto its own events) and by Copilot (which
documents reading it from the repository). So `relay-claude-pre-tool.js` runs under at
least three products, and trusting the filename is what put "Claude Code" on Cursor's
edits and made one editor claim the same file twice under two names.

`detectProduct()` identifies by evidence instead, in this order:

| Evidence | Product |
|---|---|
| `cursor_version` in the payload | Cursor |
| `workspacePaths` or `artifactDirectoryPath`; a `transcriptPath` under `~/.gemini/antigravity*`; a `toolCall` object | Antigravity |
| `turn_id` | Codex |
| `toolName`, `toolArgs` or `timestamp`; `COPILOT_AGENT_PROMPT` or `GITHUB_COPILOT_API_TOKEN` in the environment | Copilot |
| `CLAUDE_CODE_CHILD_SESSION=1` | Claude Code |
| *(none)* | The declared mode |

`CLAUDECODE` is deliberately not used — IDE extensions set it too, which is exactly the
confusion being resolved.

---

## Answer dialects

These are four genuinely different contracts. Getting one wrong fails silently in whatever
direction the product happens to default.

| Product | Allow | Deny |
|---|---|---|
| **Cursor** | `{"permission":"allow"}` | `{"permission":"deny","user_message":"…"}` |
| **Antigravity** | `{"decision":"allow"}` | `{"decision":"deny","reason":"…"}` |
| **Copilot** | `{"permissionDecision":"allow"}` | `{"permissionDecision":"deny","permissionDecisionReason":"…"}` |
| **Claude Code, Codex** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` | same envelope with `permissionDecision:"deny"` and `permissionDecisionReason` |

Notes that cost real debugging to learn:

- **Antigravity** has no `permissionDecision` and no `hookSpecificOutput`. The envelope
  parsed as "no decision", so every Antigravity lock silently allowed.
- **Copilot** is fail-**closed**: a crash or any non-zero exit denies the call. The allow
  path must exit 0.
- **Codex** shares Claude's envelope. `continue` and `stopReason` parse but are
  unsupported — returning them marks the hook failed and lets the tool run anyway, which
  makes a deny written that way worse than no hook at all.
- On deny, the shared envelope path also writes the reason to stderr and sets exit code 2.
- Post-tool and stop hooks emit `{}`. All five treat that as "no decision, carry on", and a
  PreToolUse-shaped envelope on a Stop event is at best ignored.

---

## Finding the file path

Every agent names this field differently, and renames it between versions. A hook that
does not recognise the shape claims nothing and stays silent, so the failure looks like
"Relay isn't locking" rather than "Relay didn't find the path".

So the library does both:

1. **An explicit list** — `file_path`, `tool_input.file_path`, `tool_input.target_file`,
   `tool_input.path`, `tool_input.relative_path`, `tool_input.relative_workspace_path`,
   `tool_input.file`, `TargetFile`, `AbsolutePath`, `toolCall.args.{TargetFile,
   AbsolutePath, DirectoryPath, SearchPath, SearchDirectory, file_path}`,
   `toolInput.file_path`, and the `toolArgs` / `tool_args` variants.
2. **A recursive scan**, always, for any key matching
   `file_path|target_file|absolute_path|directory_path|search_path|search_directory|filename|file|path|uri|notebook_path`
   (case- and underscore-insensitive), to depth 6, capped at 32 hits, skipping multi-line
   values and anything over 1024 characters. The scan runs even when the explicit list
   matched, because `multi_replace_file_content` can name several target files and a single
   top-level hit used to hide the rest.

Additional sources merged in: `tool_input.files`, `files`, `tool_input.target_files` and
`attachments[].file_path`.

Then each candidate is normalized:

- Copilot documents `toolArgs` as a JSON **string**; it is parsed before scanning.
- Antigravity quotes every tool argument, so `TargetFile` arrives as `"c:\\Users\\me\\app.ts"`
  with the quotes included. Surrounding quotes are stripped.
- `file:` URIs are decoded.
- A relative path is resolved against the **workspace**, not `process.cwd()` — the hook
  process spawns wherever the agent felt like, and resolving there produced paths that
  escaped the root and were silently dropped.
- Anything that still escapes the workspace root is discarded. A temp file, a sibling
  repo, a dotfile in `$HOME` is not this workspace's business, and relativizing it would
  file a foreign edit against the wrong repo.

## Finding the workspace

In order: `RELAY_WORKSPACE_PATH`, `payload.cwd`, `payload.workspace_root`,
`payload.workspace_roots[]`, `payload.workspacePaths[]` (Antigravity's only root field),
then `process.cwd()`.

## Building the agent ID

`<label>:<hostname>:<session>`, where session is the first of `session_id`,
`conversation_id`, `conversationId`, `sessionId`, `SESSION_ID`, or `local`. The camelCase
variants matter: without them every turn from Antigravity and Copilot collapsed onto the
session id `local`, and the room could not tell two concurrent turns apart.

---

## Matchers

`backend/lib/editMatchers.js` is the single source of truth. Pre and post matchers must be
identical per product or the flush never runs after a successful claim.

### Write tools

| Product | Matcher |
|---|---|
| Claude Code | `Edit\|Write\|NotebookEdit\|MultiEdit\|Replace` |
| Cursor | `Write\|Edit\|Delete\|StrReplace\|ApplyPatch\|EditNotebook\|search_replace` |
| Codex | `apply_patch\|Edit\|Write\|write\|edit_file\|create_file\|patch_file` |
| Copilot | `edit\|create\|apply_patch` |
| Antigravity | `write_to_file\|replace_file_content\|multi_replace_file_content\|edit_file\|create_file` |

### Read tools

| Product | Matcher |
|---|---|
| Claude Code | `Read\|Grep\|Glob` |
| Cursor | `Read\|Grep` (plus the dedicated `beforeReadFile` event, matcher `Read`) |
| Codex | *none* |
| Copilot | `view\|grep\|glob` |
| Antigravity | `view_file\|grep_search\|list_dir\|find_by_name` |

Codex has no read hook because it exposes no read or search tool — file reads arrive as
shell commands under the `Bash` matcher. Sniffing reads out of a command line would report
greps and cats as reads and miss everything else, so Codex contributes edits only.

---

## Config shapes

Each product's hook file has its own structure. `relay init` writes all of them.

**Claude Code** — `.claude/settings.json`, `hooks.PreToolUse[]` / `PostToolUse[]` /
`Stop[]`, each entry `{ matcher, hooks: [{ type: "command", command }] }`. This file is
**merged**, not overwritten, so your other settings survive.

**Cursor** — `.cursor/hooks.json`, `version: 1`, with `preToolUse`, `postToolUse`,
`beforeReadFile` and `stop`. Entries are `{ command, matcher, timeout }`; `stop` takes
`loop_limit: 1`.

**Codex** — `.codex/hooks.json`, same `{ matcher, hooks: [...] }` shape as Claude Code,
with `timeout` in seconds. Stop gets 120 s.

**Copilot CLI** — `.github/hooks/relay-os.json`, `version: 1`, with `preToolUse`,
`postToolUse` and `agentStop`. Entries carry **both** `bash` and `powershell` commands,
plus `cwd` and `timeoutSec`.

**Antigravity** — `.agents/hooks.json`, keyed by hook **name** at the top level:
`{ "relay": { "PreToolUse": [...], "PostToolUse": [...], "Stop": [...] } }`. Note that
`PreToolUse` and `PostToolUse` take a matcher group wrapping a `hooks` array, while `Stop`
takes the handler directly. (Writing `{"hooks": {...}}` here only ever worked by accident,
as a hook that happened to be named "hooks".)

Global equivalents live in `~/.claude`, `~/.cursor`, `~/.codex`, `~/.copilot` and
`~/.gemini/config` — the last both directly and as a plugin bundle under
`plugins/relay/`.

---

## Timeouts and budgets

| | |
|---|---|
| Hook config timeout | 10 s for pre/post and 120 s for stop, where the product's config supports one. Cursor, Codex, Copilot and Antigravity all declare timeouts; Claude Code's entries do not, and Cursor's `stop` uses `loop_limit: 1` instead. |
| Claim total budget | 3 s across the whole fallback chain |
| Local API attempt | ~800 ms |
| Remote room attempt | 2 s, then a 30 s cooldown on failure |
| Release attempt | 600 ms local |
| Heartbeat attempt | 400 ms local |
| Read report | 500 ms, then abandoned |
| stdin read | 400 ms, then whatever arrived |

A read is never awaited past its deadline: an agent must not wait on telemetry to read a
file.

---

## Debugging

Hooks fail open, which means a broken one leaves no trace and "nothing showed up" is
unfalsifiable. Set:

```bash
export RELAY_HOOK_DEBUG=1
```

Every hook then appends a JSON line to `~/.relay/hook-debug.log`. Phases:

`pre:no-files` · `pre:claim` · `read` · `post:enter` · `post:no-files` · `post:flush` ·
`post:release` · `post:flush-fail` · `post:error` · `stop:enter` · `stop:flush-owned` ·
`stop:release-all` · `stop:error`

The line records the workspace, the tool name, the agent ID, the extracted files, the
first eight raw paths and the payload's top-level keys. `pre:no-files` with a plausible
payload means path extraction missed the shape — that is the report worth filing.

The server side logs too: every request to a hook route
(`/api/ensure-workspace`, `/api/ingest-stop`, `/api/flush-file`, `/api/flush-owned`,
`/api/coord/{claim,release,release-all,heartbeat}`) prints a `[relay-hook]` line with
method, path, status, duration, workspace, agent and files.
