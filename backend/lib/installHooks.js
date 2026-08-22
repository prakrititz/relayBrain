const fs = require("fs");
const path = require("path");
const os = require("os");

function repoRoot() {
  return path.join(__dirname, "..", "..");
}

function nodeCmd(scriptRel) {
  const abs = path.join(repoRoot(), scriptRel).replace(/\\/g, "/");
  return `node "${abs}"`;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// Only writes are arbitrated. Reads are matched separately so the dashboard can
// show what every agent is looking at, and they never take a lock — an agent
// reading a file must never be able to stall an agent trying to edit one.
// Every product names its tools differently, and a matcher naming a tool that
// does not exist fires for nothing while looking perfectly healthy in the
// config. These lists are the documented tool names for each product, not
// plausible-looking guesses.
const EDIT = {
  // Bash|PowerShell|Edit|Write|Read|Glob|Grep|Agent|WebFetch|WebSearch.
  // "Replace" and "MultiEdit" are not Claude Code tools.
  claude: "Edit|Write|NotebookEdit",
  // Shell|Read|Write|Grep|Delete|Task, documented as non-exhaustive.
  cursor: "Write|Edit|Delete",
  // Everything that touches a file goes through apply_patch, which is also
  // matchable under the aliases Edit and Write.
  codex: "apply_patch|Edit|Write",
  // Runtime tool names, which is what a camelCase event name selects.
  copilot: "edit|create",
  // Documented Antigravity write tools. Path lives on toolCall.args.TargetFile
  // (quoted). view_file is a read — it is matched separately below.
  antigravity: "write_to_file|replace_file_content|multi_replace_file_content",
};

const READ = {
  // Documented Claude Code tools: PreToolUse matcher is the tool name.
  // Path: tool_input.file_path (Read) / tool_input.path (Grep, Glob).
  claude: "Read|Grep|Glob",
  // Reads are covered by the dedicated beforeReadFile event below, which is the
  // one Cursor actually guarantees for file reads. Glob/codebase_search/list_dir
  // are not matcher values and previously matched nothing.
  cursor: "Read|Grep",
  // Codex has no documented read or search tool: reads and greps run through
  // the shell, so there is nothing to match. See the note where the Codex
  // config is written.
  codex: null,
  // Copilot documents preToolUse as the read hook; runtime names are lowercase.
  // toolArgs is a JSON string with path / file_path.
  copilot: "view|grep|glob",
  // Documented Antigravity read tools. Paths: view_file.AbsolutePath,
  // list_dir.DirectoryPath, grep_search.SearchPath, find_by_name.SearchDirectory.
  // There is no PreRead event — PreToolUse with these matchers is the hook.
  antigravity: "view_file|grep_search|list_dir|find_by_name",
};

function installProjectHooks(workspacePath) {
  if (!workspacePath) return;
  const claude = nodeCmd("hooks/relay-claude-pre-tool.js");
  const claudePost = nodeCmd("hooks/relay-claude-post-tool.js");
  const claudeStop = nodeCmd("hooks/relay-claude-stop.js");
  const cursor = nodeCmd("hooks/relay-cursor-pre-tool.js");
  const cursorPost = nodeCmd("hooks/relay-cursor-post-tool.js");
  const cursorStop = nodeCmd("hooks/relay-cursor-stop.js");
  const codex = nodeCmd("hooks/relay-codex-pre-tool.js");
  const codexPost = nodeCmd("hooks/relay-codex-post-tool.js");
  const codexStop = nodeCmd("hooks/relay-codex-stop.js");
  const copilot = nodeCmd("hooks/relay-copilot-pre-tool.js");
  const copilotPost = nodeCmd("hooks/relay-copilot-post-tool.js");
  const copilotStop = nodeCmd("hooks/relay-copilot-stop.js");
  const anti = nodeCmd("hooks/relay-antigravity-pre-tool.js");
  const antiPost = nodeCmd("hooks/relay-antigravity-post-tool.js");
  const antiStop = nodeCmd("hooks/relay-antigravity-stop.js");

  writeJson(path.join(workspacePath, ".claude", "settings.json"), {
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT.claude,
          hooks: [{ type: "command", command: claude }],
        },
        {
          matcher: READ.claude,
          hooks: [{ type: "command", command: nodeCmd("hooks/relay-claude-pre-read.js") }],
        },
      ],
      PostToolUse: [
        {
          matcher: EDIT.claude,
          hooks: [{ type: "command", command: claudePost }],
        },
      ],
      Stop: [{ matcher: "*", hooks: [{ type: "command", command: claudeStop }] }],
    },
  });

  writeJson(path.join(workspacePath, ".cursor", "hooks.json"), {
    version: 1,
    hooks: {
      preToolUse: [
        {
          command: cursor,
          matcher: EDIT.cursor,
          timeout: 10,
        },
        {
          command: nodeCmd("hooks/relay-cursor-pre-read.js"),
          matcher: READ.cursor,
          timeout: 10,
        },
      ],
      postToolUse: [
        {
          command: cursorPost,
          matcher: EDIT.cursor,
          timeout: 10,
        },
      ],
      // Documented Cursor read hook. Payload: { file_path, content }. Matcher
      // filters by tool type (Read, TabRead, …). Fail-open by default: reporting
      // a read must never be able to stop the agent from reading.
      beforeReadFile: [
        {
          command: nodeCmd("hooks/relay-cursor-pre-read.js"),
          matcher: "Read",
          timeout: 10,
        },
      ],
      stop: [{ command: cursorStop, loop_limit: 1 }],
    },
  });

  // No read hook for Codex: it exposes no read or search tool, so file reads
  // arrive as shell commands under the Bash matcher. Matching Bash to sniff
  // reads out of a command line would report greps and cats as "reads" and miss
  // everything else, so Codex contributes edits only.
  writeJson(path.join(workspacePath, ".codex", "hooks.json"), {
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT.codex,
          hooks: [{ type: "command", command: codex, timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: EDIT.codex,
          hooks: [{ type: "command", command: codexPost, timeout: 10 }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: codexStop, timeout: 120 }] }],
    },
  });

  writeJson(path.join(workspacePath, ".github", "hooks", "relay-os.json"), {
    version: 1,
    hooks: {
      preToolUse: [
        {
          type: "command",
          bash: copilot,
          powershell: copilot,
          matcher: EDIT.copilot,
          cwd: ".",
          timeoutSec: 10,
        },
        {
          type: "command",
          bash: nodeCmd("hooks/relay-copilot-pre-read.js"),
          powershell: nodeCmd("hooks/relay-copilot-pre-read.js"),
          matcher: READ.copilot,
          cwd: ".",
          timeoutSec: 10,
        },
      ],
      postToolUse: [
        {
          type: "command",
          bash: copilotPost,
          powershell: copilotPost,
          matcher: EDIT.copilot,
          cwd: ".",
          timeoutSec: 10,
        },
      ],
      agentStop: [
        {
          type: "command",
          bash: copilotStop,
          powershell: copilotStop,
          cwd: ".",
          timeoutSec: 120,
        },
      ],
    },
  });

  writeJson(path.join(workspacePath, ".agents", "hooks.json"), antigravityHooks(anti, antiPost, antiStop));
}

/**
 * Antigravity's config is keyed by hook NAME at the top level, and each name
 * maps to its events — `{"relay": {"PreToolUse": [...]}}`. We were writing
 * `{"hooks": {...}}`, which only worked by accident, as a hook that happened to
 * be named "hooks".
 *
 * The event shapes also differ from each other: PreToolUse and PostToolUse take
 * a matcher group wrapping a `hooks` array, while Stop takes the handler
 * directly.
 */
function antigravityHooks(pre, post, stop) {
  return {
    relay: {
      PreToolUse: [
        {
          matcher: EDIT.antigravity,
          hooks: [{ type: "command", command: pre, timeout: 10 }],
        },
        {
          matcher: READ.antigravity,
          hooks: [{ type: "command", command: nodeCmd("hooks/relay-antigravity-pre-read.js"), timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: EDIT.antigravity,
          hooks: [{ type: "command", command: post, timeout: 10 }],
        },
      ],
      Stop: [{ type: "command", command: stop, timeout: 120 }],
    },
  };
}

function mergeClaudeSettings(file, preCmd, postCmd, stopCmd) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    existing = {};
  }
  existing.hooks = existing.hooks || {};
  existing.hooks.PreToolUse = [
    {
      matcher: EDIT.claude,
      hooks: [{ type: "command", command: preCmd }],
    },
    {
      matcher: READ.claude,
      hooks: [{ type: "command", command: nodeCmd("hooks/relay-claude-pre-read.js") }],
    },
  ];
  existing.hooks.PostToolUse = [
    {
      matcher: EDIT.claude,
      hooks: [{ type: "command", command: postCmd }],
    },
  ];
  existing.hooks.Stop = [{ matcher: "*", hooks: [{ type: "command", command: stopCmd }] }];
  writeJson(file, existing);
}

function installGlobalHooks() {
  const home = os.homedir();
  mergeClaudeSettings(
    path.join(home, ".claude", "settings.json"),
    nodeCmd("hooks/relay-claude-pre-tool.js"),
    nodeCmd("hooks/relay-claude-post-tool.js"),
    nodeCmd("hooks/relay-claude-stop.js")
  );
  writeJson(path.join(home, ".cursor", "hooks.json"), {
    version: 1,
    hooks: {
      preToolUse: [
        {
          command: nodeCmd("hooks/relay-cursor-pre-tool.js"),
          matcher: EDIT.cursor,
          timeout: 10,
        },
        {
          command: nodeCmd("hooks/relay-cursor-pre-read.js"),
          matcher: READ.cursor,
          timeout: 10,
        },
      ],
      postToolUse: [
        {
          command: nodeCmd("hooks/relay-cursor-post-tool.js"),
          matcher: EDIT.cursor,
          timeout: 10,
        },
      ],
      beforeReadFile: [
        {
          command: nodeCmd("hooks/relay-cursor-pre-read.js"),
          matcher: "Read",
          timeout: 10,
        },
      ],
      stop: [{ command: nodeCmd("hooks/relay-cursor-stop.js"), loop_limit: 1 }],
    },
  });
  writeJson(path.join(home, ".codex", "hooks.json"), {
    hooks: {
      PreToolUse: [
        {
          matcher: EDIT.codex,
          hooks: [{ type: "command", command: nodeCmd("hooks/relay-codex-pre-tool.js"), timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: EDIT.codex,
          hooks: [{ type: "command", command: nodeCmd("hooks/relay-codex-post-tool.js"), timeout: 10 }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: nodeCmd("hooks/relay-codex-stop.js"), timeout: 120 }],
        },
      ],
    },
  });
  const antigravity = antigravityHooks(
    nodeCmd("hooks/relay-antigravity-pre-tool.js"),
    nodeCmd("hooks/relay-antigravity-post-tool.js"),
    nodeCmd("hooks/relay-antigravity-stop.js")
  );
  // Antigravity reads global hooks from ~/.gemini/config, either directly or
  // from a plugin bundle under it.
  writeJson(path.join(home, ".gemini", "config", "plugins", "relay", "hooks.json"), antigravity);
  writeJson(path.join(home, ".gemini", "config", "hooks.json"), antigravity);
}

module.exports = { installProjectHooks, installGlobalHooks };
