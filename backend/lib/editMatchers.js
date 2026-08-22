/**
 * Single source of truth for write-tool hook matchers (PreToolUse + PostToolUse)
 * and transcript edit detection. Keep pre/post identical per product or flush
 * never runs after a successful claim.
 *
 * Sources (2025–2026):
 * - Cursor hooks: preToolUse/postToolUse match tool_name (Write, Edit, Delete, …)
 * - Claude Code hooks: PostToolUse matcher = tool name (Edit|Write|NotebookEdit, …)
 * - Codex hooks: apply_patch|Edit|Write (+ runtime names in transcripts)
 * - Copilot CLI: postToolUse matcher = toolName regex (edit|create|apply_patch)
 * - Antigravity: PreToolUse/PostToolUse matcher on toolCall.name
 */

function matcherToSet(matcher) {
  return new Set(
    String(matcher || "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const EDIT = {
  // code.claude.com/docs/en/hooks — PostToolUse matcher on tool name
  claude: "Edit|Write|NotebookEdit|MultiEdit|Replace",
  // cursor.com/docs/hooks — postToolUse matcher on tool_name; StrReplace/ApplyPatch
  // appear in agent transcripts but are under-documented in the matcher list.
  cursor: "Write|Edit|Delete|StrReplace|ApplyPatch|EditNotebook|search_replace",
  // Codex hook config + session transcript tool names
  codex: "apply_patch|Edit|Write|write|edit_file|create_file|patch_file",
  // docs.github.com/copilot/reference/hooks-reference — toolName edit|create
  copilot: "edit|create|apply_patch",
  // Antigravity write tools (TargetFile on toolCall.args)
  antigravity: "write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file",
};

const READ = {
  claude: "Read|Grep|Glob",
  cursor: "Read|Grep",
  codex: null,
  copilot: "view|grep|glob",
  antigravity: "view_file|grep_search|list_dir|find_by_name",
};

const EDIT_TOOL_SETS = {
  cursor: matcherToSet(EDIT.cursor),
  claude: matcherToSet(EDIT.claude),
  codex: matcherToSet(EDIT.codex),
  copilot: matcherToSet(EDIT.copilot),
  antigravity: matcherToSet(EDIT.antigravity),
};

module.exports = { EDIT, READ, EDIT_TOOL_SETS, matcherToSet };
