# Codex Persistent State & Memory Extraction

Based on a forensic analysis of the local environment for Codex (`~/.codex`), the state is distributed across a hybrid of SQLite databases and version-controlled Markdown files.

## 1. Storage Location & Session Management
All persistent state resides inside the user's home directory:
`C:\Users\[Username]\.codex\`

Sessions (called "rollouts") are stored in a nested date structure:
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

To map a rollout to a workspace, the `session_meta` event on the first line of the transcript contains the `cwd` (Current Working Directory). A global `session_index.jsonl` also keeps track of all past rollouts.

## 2. Transcripts (The Execution Log)
- **Location:** `~/.codex/sessions/**/*.jsonl`
- **Format:** JSONL
- **Contents:** The transcripts log every `user_message`, `agent_message`, and raw UI execution events natively.

## 3. The Markdown Memory System (Highly Valuable)
Unlike Cursor which embeds memory exclusively in SQLite, Codex builds a highly structured, human-readable markdown memory tree.
- **Location:** `~/.codex/memories/`
- **Contents:** `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, and a `rollout_summaries/` directory.
- **Crucial Detail:** This entire `memories` directory contains a hidden `.git` folder. Codex natively version-controls its own memory so it can rollback hallucinations or corrupted memories! This is a perfect target for the Universal IR.

## 4. SQLite Databases (System State)
Codex uses several SQLite databases for tracking internal runtime state:
- **`goals_1.sqlite`**: Tracks the internal "TODO" list and task breakdown for the agent.
- **`logs_2.sqlite`**: Stores detailed background logs and tool executions.
- **`memories_1.sqlite`**: Likely a vector/indexing database that backs up the Markdown memory system.
- **`state_5.sqlite`**: Maintains the overall GUI state and checkpoints.

## 5. Rules & Skills
- **Rules:** `~/.codex/rules/default.rules` stores behavioral constraints.
- **Skills:** `~/.codex/skills/` stores generated "macros" or reusable commands the agent has learned.

## Conclusion
To fully reconstruct Codex's state for Relay:
1. **Transcripts:** Parse the JSONL rollouts to reconstruct the timeline (Already implemented).
2. **Memory IR:** Sync directly with `~/.codex/memories/MEMORY.md` and `memory_summary.md`. These files are already in a structured Markdown format and map 1:1 with Relay's vision for project intelligence.
3. **Tasks:** Query `goals_1.sqlite` to sync the active TODO list.
