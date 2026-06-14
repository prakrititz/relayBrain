# Cursor Persistent State & Memory Extraction

Based on a forensic analysis of the local environment for Cursor (a fork of VS Code), here is the detailed breakdown of how it stores its persistent state, memory, and chat history.

## 1. Storage Location & Session Management
Cursor manages its state extremely similarly to VS Code, relying heavily on SQLite and hashed workspace directories.

**Global Storage:** `C:\Users\[Username]\AppData\Roaming\Cursor\User\globalStorage\`
**Workspace Storage:** `C:\Users\[Username]\AppData\Roaming\Cursor\User\workspaceStorage\[hash]\`

To map a workspace path to its `[hash]`, you must read the `workspace.json` file inside each hash directory.

## 2. Transcripts (The Execution Log)
Cursor does not store plain-text or JSONL transcripts. Like Copilot, the chat history is embedded directly into the IDE's SQLite database.
- **Location:** `workspaceStorage/[hash]/state.vscdb`
- **Format:** SQLite 3 Database
- **Keys:** Look in the `ItemTable` for keys prefixed with `workbench.panel.aichat.view` or `cursor.chat`. The values are stringified JSON blobs representing the conversation.

## 3. Planning, Tasks, and Rules (The Mental Model)
Cursor relies on explicit human-editable markdown files in the workspace rather than a hidden backend planning system.
- **Root Rules:** `.cursorrules` (Global instructions for the repository).
- **Modular Rules:** `.cursor/rules/*.mdc` (Specific context rules applied to subsets of files).
These are exactly the kinds of files Relay aims to target and generate as part of its Universal IR!

## 4. Context & Retrieval Indices
Cursor builds a local semantic index to understand the codebase.
- **Location:** `workspaceStorage/[hash]/anysphere.cursor-retrieval/`
- **Contents:** Contains metadata like `embeddable_files.txt` and `high_level_folder_description.txt`, which track what files Cursor has fed into its RAG pipeline.

## 5. Checkpoints & Undo System
Cursor includes a powerful "Composer" feature that can generate code across multiple files. To support rolling back these massive changes, it maintains a checkpoint system independent of standard Git.
- **Location:** `globalStorage/anysphere.cursor-commits/checkpoints/[UUID]/`
- **Purpose:** Stores complete snapshots of file states before and after a massive AI-driven refactoring operation.

## Conclusion
To fully reconstruct Cursor's state or integrate it with Relay:
1. **Extract `state.vscdb`:** Requires a SQLite connection to parse the raw chat blobs.
2. **Read `.cursorrules` and `.cursor/rules/`:** This is the most critical extraction point for the agent's actual "memory" and behavioral constraints.
3. **Analyze `anysphere.cursor-commits`:** This provides the exact file diffs/checkpoints of what the AI actually changed during complex generations.
