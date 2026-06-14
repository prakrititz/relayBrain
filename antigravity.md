# Antigravity Persistent State & Memory Extraction

Based on a deep forensic analysis of the Antigravity local environment (as per the objectives in `nextSteps.md`), the state is much more complex than just transcripts. 

Here are the complete findings on how to fully recreate the agent's understanding of a project.

## 1. Storage Location & Session Management
All persistent state resides inside the Antigravity App Data directory:
`C:\Users\Prakrititz Borah\.gemini\antigravity-ide`

Conversations (Sessions) are assigned a unique "brain UUID". For example:
`.../brain/56f9135c-2f00-46c5-8899-ac16f108ac58/`

## 2. Transcripts (The Execution Log)
- **Location:** `brain/[ID]/.system_generated/logs/transcript.jsonl`
- **Format:** JSONL
- **Purpose:** Records the raw chronological sequence of User Inputs, Agent Responses, Tool Calls, and System events.

## 3. Planning & Task State
Antigravity explicitly decouples long-term planning from the transcript by writing stateful, versioned Markdown artifacts.
- **Implementation Plans:** `brain/[ID]/artifacts/implementation_plan.md`
- **Task Tracking (TODOs):** `brain/[ID]/artifacts/task.md`
- **Execution Summaries:** `brain/[ID]/artifacts/walkthrough.md`
*Each of these has a corresponding `.metadata.json` tracking internal system status.*

## 4. Background Tasks & Tool Execution
When Antigravity runs long-running shell commands, it streams the output into dedicated task logs rather than flooding the transcript.
- **Task Logs:** `brain/[ID]/.system_generated/tasks/*.log` (e.g., `task-1082.log`)
- **System Messages:** `brain/[ID]/.system_generated/messages/*.json` (Tracks background task completions, subagent messages, and timer expirations).

## 5. Artifacts, Media & Scratch
- **Generated Media:** `brain/[ID]/media_*.png` (Images the agent generated or received).
- **Temporary Code/Data:** `brain/[ID]/scratch/` (Scripts the agent wrote temporarily to test logic).

## 6. Global Knowledge Items (Memory)
Antigravity maintains a persistent memory system across all workspaces, extracting patterns and rules to avoid repeating mistakes.
- **Location:** `~/.gemini/antigravity-ide/knowledge/`
- **Format:** Contains subfolders for each Knowledge Item (KI), housing `metadata.json` and associated `artifacts/`.

## Conclusion
To fully reconstruct Antigravity's state, one must extract:
1. **The Transcript** for chronological context.
2. **The Artifacts (`task.md`, `implementation_plan.md`)** for the agent's current mental model of progress.
3. **The Tasks folder** for exact shell execution history and outputs.
4. **The Knowledge folder** for cross-session global learnings.
