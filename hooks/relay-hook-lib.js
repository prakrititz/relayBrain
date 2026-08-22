#!/usr/bin/env node
/**
 * Shared hook library. Fail-open.
 * Pre-tool claims (15s TTL). Post-tool flushes the finished file + releases it.
 * Stop releases leftovers + transcript ingest.
 */
const os = require("os");
const path = require("path");

// Loaded on demand. Read hooks fire on nearly every tool call an agent makes and
// only need an HTTP POST; making them pay to load the coordinator client and the
// dependency graph parser would put that cost in front of every file an agent
// looks at.
let clientMod = null;
function client() {
  if (!clientMod) clientMod = require("../backend/coordinator/client");
  return clientMod;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "")));
    setTimeout(() => resolve(data.replace(/^\uFEFF/, "")), 400);
  });
}

function normalizeWorkspaceRoot(root) {
  if (!root || typeof root !== "string") return null;
  let trimmed = root.trim();
  if (!trimmed) return null;
  trimmed = trimmed.replace(/^file:\/+/i, "/");
  const drive = trimmed.match(/^\/?([a-zA-Z]):([\\/].*)$/);
  if (drive) trimmed = `${drive[1]}:${drive[2]}`;
  const doubled = trimmed.match(/^([a-zA-Z]):[\\/]+\1:[\\/]+(.*)$/i);
  if (doubled) trimmed = `${doubled[1]}:\\${doubled[2]}`;
  return path.resolve(trimmed);
}

// Antigravity quotes every tool argument, so TargetFile arrives as the literal
// string `"c:\\Users\\me\\app.ts"` — surrounding quotes included. A quoted path
// is not path.isAbsolute, so it was resolved against the workspace and dropped
// as foreign: claims never reached the board while Activity still showed the
// transcript. Same unwrap as backend/lib/transcripts/parse.js antigravityArg.
function unquoteArg(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
  return trimmed || null;
}

function normalizeHookPath(raw) {
  const unquoted = unquoteArg(raw);
  if (!unquoted) return null;
  let s = unquoted;
  if (/^file:/i.test(s)) {
    try {
      const rest = decodeURIComponent(s.replace(/^file:\/+/i, ""));
      s = /^[a-zA-Z]:/.test(rest) || rest.startsWith("/") ? rest : `/${rest}`;
    } catch {
      /* keep the unquoted form */
    }
  }
  return s || null;
}

function hydratePayload(payload) {
  const p = payload && typeof payload === "object" ? { ...payload } : {};
  // Copilot documents toolArgs as a JSON string, not an object. Leave it as a
  // string and the path scan sees none of view/grep/glob's fields.
  for (const key of ["toolArgs", "tool_args", "tool_input"]) {
    if (typeof p[key] === "string" && p[key].trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(p[key]);
        if (parsed && typeof parsed === "object") p[key] = parsed;
      } catch {
        /* leave as string */
      }
    }
  }
  return p;
}

function toolNameFromPayload(payload) {
  const p = hydratePayload(payload);
  return p.tool_name || p.toolName || p.tool_input?.tool || p.name || null;
}

function extractFilePath(payload) {
  const p = hydratePayload(payload);
  const args = p.toolCall?.args || p.toolCall?.arguments || {};
  return (
    // Cursor's beforeReadFile / beforeTabFileRead put the path at the top level
    // rather than under tool_input. postToolUse uses tool_name + tool_input.
    p.file_path ||
    p.tool_input?.file_path ||
    p.tool_input?.target_file ||
    p.tool_input?.path ||
    p.tool_input?.relative_path ||
    p.tool_input?.relative_workspace_path ||
    p.tool_input?.file ||
    p.TargetFile ||
    p.AbsolutePath ||
    args.TargetFile ||
    args.AbsolutePath ||
    args.DirectoryPath ||
    args.SearchPath ||
    args.SearchDirectory ||
    args.file_path ||
    p.toolInput?.file_path ||
    p.toolArgs?.file_path ||
    p.toolArgs?.target_file ||
    p.toolArgs?.TargetFile ||
    p.toolArgs?.path ||
    p.tool_args?.file_path ||
    p.tool_args?.target_file ||
    p.tool_args?.path ||
    null
  );
}

// Every agent names this field differently, and renames it between versions.
// A hook that does not recognise the shape claims nothing and stays silent, so
// the failure looks like "Relay isn't locking" rather than "Relay didn't find
// the path" — which is why the explicit list above is backed by a scan.
const PATH_KEY =
  /^(file_?path|target_?file|absolute_?path|directory_?path|search_?path|search_?directory|filename|file|path|uri|notebook_?path)$/i;

function scanForPaths(value, depth = 0, out = new Set()) {
  if (depth > 6 || out.size > 32) return out;
  if (Array.isArray(value)) {
    for (const item of value) scanForPaths(item, depth + 1, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (PATH_KEY.test(key) && item.trim() && !item.includes("\n") && item.length < 1024) {
        out.add(item);
      }
    } else {
      scanForPaths(item, depth + 1, out);
    }
  }
  return out;
}

function extractFilePaths(payload) {
  const p = hydratePayload(payload);
  const one = extractFilePath(p);
  const extra = []
    .concat(p.tool_input?.files || [])
    .concat(p.files || [])
    .concat(p.tool_input?.target_files || [])
    .concat((p.attachments || []).map((a) => a && a.file_path));
  const named = [one, ...extra].filter((v) => typeof v === "string" && v.trim());
  // Always scan: multi_replace_file_content can name several TargetFiles, and a
  // single top-level hit used to hide the rest.
  return [...new Set([...named, ...scanForPaths(p)])];
}

// An agent can edit a path outside the workspace it was started in (a temp file,
// a sibling repo, a dotfile in $HOME). Relativizing those produces a "../../.."
// path that gets locked and flushed against whichever workspace happens to be
// current — foreign edits landing in this workspace's activity feed. Anything
// that escapes the root is simply not this workspace's business.
function workspaceRelativeFiles(workspace, filePaths) {
  const out = [];
  for (const raw of filePaths) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    // A relative path in the payload is relative to the WORKSPACE, not to
    // wherever the agent happened to spawn this hook process. Resolving it
    // against process.cwd() produced paths that escaped the root and were then
    // dropped as foreign — a silent no-claim.
    const cleaned = normalizeHookPath(raw);
    if (!cleaned) continue;
    const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(workspace, cleaned);
    const rel = path.relative(workspace, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) continue;
    out.push(rel);
  }
  return [...new Set(out)];
}

// Opt-in, off by default: RELAY_HOOK_DEBUG=1 appends what each hook saw to
// ~/.relay/hook-debug.log. A hook that fails open leaves no other trace, so
// without this "nothing showed up" is unfalsifiable.
//
// Post-tool phases: post:enter, post:no-files, post:flush, post:release,
// post:flush-fail, post:error. Stop: stop:flush-owned, stop:release-all.
function debugHook(mode, phase, detail) {
  if (!process.env.RELAY_HOOK_DEBUG) return;
  try {
    const fs = require("fs");
    const file = path.join(os.homedir(), ".relay", "hook-debug.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${mode} ${phase} ${JSON.stringify(detail)}\n`);
  } catch {
    /* debugging must never break the hook */
  }
}

function modeLabel(mode) {
  const map = {
    claude: "Claude Code",
    cursor: "Cursor",
    codex: "Codex",
    copilot: "Copilot",
    antigravity: "Antigravity",
  };
  return map[mode] || mode;
}

/**
 * Which product is actually running this hook?
 *
 * The script's own name can't answer that. `.claude/settings.json` is read by
 * Claude Code, by Cursor (which maps the Claude-style config onto its own
 * events) and by Copilot (which documents reading `.claude/settings.json` from
 * the repo). So `relay-claude-pre-tool.js` runs under at least three products,
 * and trusting the filename is what put "Claude Code" on Cursor's edits and
 * made one editor claim the same file twice under two names.
 *
 * Each product leaves a distinct fingerprint in its payload, so identify by
 * evidence and fall back to the declared mode only when there is none.
 */
function detectProduct(payload, declared) {
  const p = payload || {};

  // Cursor stamps every hook payload with its version.
  if (typeof p.cursor_version === "string") return "cursor";

  // Antigravity is the only one with workspacePaths/artifactDirectoryPath, and
  // its transcripts live under ~/.gemini/antigravity*.
  if (Array.isArray(p.workspacePaths) || typeof p.artifactDirectoryPath === "string") return "antigravity";
  if (typeof p.transcriptPath === "string" && /[\\/]\.gemini[\\/]antigravity/i.test(p.transcriptPath)) {
    return "antigravity";
  }
  if (p.toolCall && typeof p.toolCall === "object") return "antigravity";

  // turn_id is documented as a Codex-specific extension to the payload.
  if (typeof p.turn_id === "string") return "codex";

  // Copilot is the only one that puts a timestamp in the payload, and its
  // camelCase event names produce camelCase tool fields.
  if (p.toolName !== undefined || p.toolArgs !== undefined || p.timestamp !== undefined) return "copilot";
  if (process.env.COPILOT_AGENT_PROMPT || process.env.GITHUB_COPILOT_API_TOKEN) return "copilot";

  // Claude Code sets this on subprocesses it spawns itself. CLAUDECODE is not
  // usable here because IDE extensions set it too, which is exactly the
  // confusion we are trying to resolve.
  if (process.env.CLAUDE_CODE_CHILD_SESSION === "1") return "claude";

  return declared;
}

// In a shared room the lock UI has to answer "who is holding this?" across
// machines, and an agentId alone only says "Claude Code on some hostname".
function currentLogin() {
  try {
    return require("../backend/lib/store").loadSession().login || os.userInfo().username || null;
  } catch {
    return null;
  }
}

function lockAgentIdFor(mode, payload) {
  const session =
    payload.session_id ||
    payload.conversation_id ||
    // Antigravity and Copilot both name this in camelCase. Missing them meant
    // every turn from those two collapsed onto the session id "local", so the
    // room could not tell two concurrent Antigravity turns apart.
    payload.conversationId ||
    payload.sessionId ||
    process.env.SESSION_ID ||
    "local";
  return `${modeLabel(mode)}:${os.hostname()}:${session}`;
}

function resolveWorkspacePath(payload) {
  const candidates = [
    process.env.RELAY_WORKSPACE_PATH,
    payload.cwd,
    payload.workspace_root,
    ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []),
    // Antigravity's only root field. Without it every Antigravity hook fell
    // through to process.cwd(), which is wherever the IDE happened to spawn
    // the hook — so claims and edits were filed against the wrong workspace,
    // or dropped as outside it.
    ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
    process.cwd(),
  ];
  for (const raw of candidates) {
    const resolved = normalizeWorkspaceRoot(raw);
    if (resolved) return resolved;
  }
  return process.cwd();
}

/**
 * Answer in the dialect the running product actually speaks.
 *
 * These are four genuinely different contracts, and getting one wrong fails
 * silently in whichever direction the product happens to default:
 *  - Cursor  : {permission}                       — fail-open
 *  - Claude  : hookSpecificOutput.permissionDecision, top-level decision/reason
 *              being deprecated for PreToolUse
 *  - Codex   : the same envelope as Claude. `continue`/`stopReason` parse but
 *              are unsupported here, and returning them marks the hook failed
 *              and lets the tool run anyway, so a deny written that way is
 *              worse than no hook at all
 *  - Copilot : a flat {permissionDecision}, no envelope. Fail-CLOSED: a crash
 *              or any non-zero exit denies the call, so allow must exit 0
 *  - Antigrav: a top-level {decision}. It has no permissionDecision and no
 *              hookSpecificOutput, so the envelope we used to send parsed as
 *              "no decision" and every Antigravity lock silently allowed
 */
function respond(mode, allowed, reason) {
  if (mode === "cursor") {
    process.stdout.write(
      JSON.stringify(allowed ? { permission: "allow" } : { permission: "deny", user_message: reason })
    );
    return;
  }
  if (mode === "antigravity") {
    process.stdout.write(
      JSON.stringify(allowed ? { decision: "allow" } : { decision: "deny", reason })
    );
    return;
  }
  if (mode === "copilot") {
    process.stdout.write(
      JSON.stringify(
        allowed
          ? { permissionDecision: "allow" }
          : { permissionDecision: "deny", permissionDecisionReason: reason }
      )
    );
    return;
  }
  // Claude Code and Codex share the hookSpecificOutput envelope.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowed ? "allow" : "deny",
        ...(allowed ? {} : { permissionDecisionReason: reason }),
      },
    })
  );
  if (!allowed) {
    process.stderr.write(reason + "\n");
    process.exitCode = 2;
  }
}

async function runPreTool(declaredMode) {
  let mode = declaredMode;
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    mode = detectProduct(payload, declaredMode);
    const workspace = resolveWorkspacePath(payload);
    fetch(`http://127.0.0.1:${process.env.RELAY_PORT || 3001}/api/ensure-workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: workspace }),
    }).catch(() => undefined);
    const files = workspaceRelativeFiles(workspace, extractFilePaths(payload));
    if (!files.length) {
      debugHook(mode, "pre:no-files", { workspace, keys: Object.keys(payload) });
      respond(mode, true);
      return;
    }
    const agentId = lockAgentIdFor(mode, payload);
    const { dependsOn } = require("../backend/lib/deps");
    const deps = files.flatMap((rel) => dependsOn(workspace, rel));
    const result = await client().claimFile(workspace, agentId, files[0], 15000, {
      dependsOn: deps,
      files: files.length > 1 ? files : undefined,
      mode: payload.mode === "read" ? "read" : "write",
      holder: { label: modeLabel(mode), host: os.hostname(), login: currentLogin() },
    });
    debugHook(mode, "pre:claim", { workspace, files, agentId, via: result.via || null, allowed: result.allowed });
    if (result.allowed === false) {
      respond(mode, false, result.reason || `Locked by ${result.holder}. Pick a different file.`);
      return;
    }
    client().heartbeat(workspace, agentId, files[0]).catch(() => undefined);
    respond(mode, true);
  } catch {
    respond(mode, true);
  }
}

/**
 * A read tool fired. Report it and get out of the way.
 *
 * This never claims, never blocks and never denies: reading a file is not a
 * claim on it. It is reported so the room can see what every agent is actually
 * working through, instead of the dashboard only lighting up for the few files
 * being written.
 */
async function runPreRead(declaredMode) {
  let mode = declaredMode;
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    mode = detectProduct(payload, declaredMode);
    const workspace = resolveWorkspacePath(payload);
    const files = workspaceRelativeFiles(workspace, extractFilePaths(payload));
    if (files.length) {
      const port = process.env.RELAY_PORT || 3001;
      // Deliberately not awaited past a short deadline: an agent must never wait
      // on telemetry to read a file.
      await Promise.race([
        fetch(`http://127.0.0.1:${port}/api/coord/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspacePath: workspace,
            workspaceId: workspace,
            agentId: lockAgentIdFor(mode, payload),
            files,
            mode: "read",
            holder: { label: modeLabel(mode), host: os.hostname(), login: currentLogin() },
          }),
        }).catch(() => undefined),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      debugHook(mode, "read", { workspace, files });
    }
    respond(mode, true);
  } catch {
    respond(mode, true);
  }
}

// PostToolUse and Stop don't need a verdict from us — we only observe there.
// Every one of the five treats an empty object as "no decision, carry on", and
// a PreToolUse-shaped envelope on a Stop event is at best ignored.
function respondPost() {
  process.stdout.write("{}");
}

async function flushFiles(workspace, agentId, files) {
  const port = process.env.RELAY_PORT || 3001;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/flush-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: workspace, agentId, files }),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function flushOwned(workspace, agentId) {
  const port = process.env.RELAY_PORT || 3001;
  try {
    await fetch(`http://127.0.0.1:${port}/api/flush-owned`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspacePath: workspace, agentId }),
    });
  } catch {
    /* fail-open */
  }
}

async function runPostTool(declaredMode) {
  let mode = declaredMode;
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    mode = detectProduct(payload, declaredMode);
    const workspace = resolveWorkspacePath(payload);
    const rawPaths = extractFilePaths(payload);
    const files = workspaceRelativeFiles(workspace, rawPaths);
    const agentId = lockAgentIdFor(mode, payload);
    const toolName = toolNameFromPayload(payload);
    debugHook(mode, "post:enter", {
      workspace,
      toolName,
      agentId,
      files,
      rawPaths: rawPaths.slice(0, 8),
      keys: Object.keys(payload),
    });
    if (!files.length) {
      debugHook(mode, "post:no-files", {
        workspace,
        toolName,
        rawPaths: rawPaths.slice(0, 8),
        keys: Object.keys(payload),
      });
      respondPost();
      return;
    }
    const flushed = await flushFiles(workspace, agentId, files);
    debugHook(mode, "post:flush", {
      workspace,
      files,
      agentId,
      ok: flushed.ok,
      status: flushed.status,
      flushed: flushed.body?.flushed,
      error: flushed.error,
    });
    if (!flushed.ok) {
      debugHook(mode, "post:flush-fail", { workspace, files, agentId, ...flushed });
    }
    for (const file of files) {
      const released = await client().releaseFile(workspace, agentId, file);
      debugHook(mode, "post:release", {
        workspace,
        file,
        agentId,
        ok: released?.ok,
        released: released?.released,
        reason: released?.reason,
      });
    }
    respondPost();
  } catch (err) {
    debugHook(mode, "post:error", { message: err?.message || String(err) });
    respondPost();
  }
}

async function ingestStop(workspace, agentId, payload, mode) {
  try {
    await fetch(`http://127.0.0.1:${process.env.RELAY_PORT || 3001}/api/ingest-stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspacePath: workspace,
        agentId,
        agent: modeLabel(mode),
        sessionId:
          payload.session_id || payload.conversation_id || payload.conversationId || payload.sessionId,
        transcript_path: payload.transcript_path || payload.transcriptPath,
        messages: payload.messages || [],
      }),
    });
  } catch {
    /* fail-open */
  }
}

async function runStop(declaredMode) {
  let mode = declaredMode;
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    mode = detectProduct(payload, declaredMode);
    const workspace = resolveWorkspacePath(payload);
    const agentId = lockAgentIdFor(mode, payload);
    debugHook(mode, "stop:enter", { workspace, agentId });
    await flushOwned(workspace, agentId);
    debugHook(mode, "stop:flush-owned", { workspace, agentId });
    const released = await client().releaseAll(workspace, agentId);
    debugHook(mode, "stop:release-all", { workspace, agentId, released: released?.released });
    await ingestStop(workspace, agentId, payload, mode);
    respondPost();
  } catch (err) {
    debugHook(mode, "stop:error", { message: err?.message || String(err) });
    respondPost();
  }
}

module.exports = {
  runPreTool,
  runPreRead,
  runPostTool,
  runStop,
  extractFilePath,
  extractFilePaths,
  workspaceRelativeFiles,
  lockAgentIdFor,
  resolveWorkspacePath,
  detectProduct,
  toolNameFromPayload,
  respond,
};
