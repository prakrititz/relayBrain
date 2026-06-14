# Normalize Relay Storage to Standard Universal Format

Based on your updates to the README and the vision of Relay acting as a "compiler" and shared protocol for project intelligence, our current storage format (`.relay/memory.json` with agent-siloed events) needs to be upgraded into a true **Universal Intermediate Representation (IR)**.

## Goal
To decouple agent memory from isolated JSON arrays and store the extracted context in a highly structured, standard, and human/agent-readable format.

## Open Questions
> [!IMPORTANT]
> **LLM Summarization vs. Raw Markdown:** 
> Do you want the backend to actively use an LLM (e.g. via an API key) to summarize the chat history into `project.md`, `decisions.md`, etc.? 
> **Or** should the backend simply merge the parsed transcripts into a single unified `timeline.md` (and a global `memory.json`), leaving the generation of `architecture.md` / `decisions.md` up to the agents themselves (who can read `timeline.md` and write to the others)? 
> *I recommend the latter for now to keep the backend fast, deterministic, and free of API keys.*

## Proposed Changes

### 1. Unified `memory.json` Schema
Currently, `memory.json` stores events grouped by agent (`memory.agents[Codex].events`). 
We will refactor `syncWorkspace` to:
- Flatten all events across all connected agents.
- Sort them strictly by timestamp (`ts`).
- Output a single global `timeline` array in `memory.json`.

### 2. Auto-Generate Markdown IR (`.relay/history.md`)
AI agents and humans read Markdown much better than JSON. 
Every time a sync happens, the backend will automatically compile the unified `memory.json` timeline into a `.relay/history.md` file. 

Format of `history.md`:
```markdown
# Relay Unified History
*Last Synced: 2026-06-14T...*

### [Codex] User (10:00 AM)
How do we handle auth?

### [Codex] Assistant (10:01 AM)
We use JWT...

### [Antigravity] User (10:05 AM)
Implement the JWT auth from the Codex discussion.
```

### 3. Scaffold the Universal IR Files
When a workspace is registered, Relay will automatically scaffold the human-readable Markdown directory structure mentioned in the README:
- `.relay/project.md`
- `.relay/architecture.md`
- `.relay/decisions.md`
- `.relay/current_task.md`
- `.relay/failures.md`

### 4. Frontend Updates
Update the `basic_frontend/index.html` to consume the new flattened `memory.json` timeline array directly instead of iterating through `memory.agents`.

---

## Verification Plan
1. Trigger a `/api/sync` and inspect `.relay/memory.json` to ensure the global `timeline` array exists.
2. Open `.relay/history.md` in VS Code and verify it renders a clean, chronological timeline of all agents.
3. Verify the `.relay/` directory contains the scaffolded IR markdown files.
4. Open the frontend UI and ensure the timeline still renders perfectly with the new data structure.
