# Relay Initialization Workflow

## The Problem
Agents like Claude Code and Codex store their conversation transcripts in globally centralized directories using hashed identifiers (like `c--Users-Prakrititz...` or `019ec38d-...`) rather than simple project-based folders. When Relay boots up, it doesn't instantly know *which* of those hashed files belongs to the current workspace's active session.

## The Handshake Protocol (Initialization)

To reliably map a workspace to its specific agent transcript, Relay uses a **Prompt Handshake Protocol**.

### Step 1: Request Initialization
From the Relay Mission Control frontend, the user clicks the **"Connect [Agent]"** button (e.g., "Connect Antigravity" or "Connect Codex").

### Step 2: Generate Unique Token
The frontend generates a highly unique initialization string for that session.
*Example: `RELAY_INIT_HANDSHAKE_ANTIGRAVITY_8f4b2a99`*

The UI prompts the user to copy this string and paste it into the chat interface of the target agent.

### Step 3: Agent Acknowledgment
The user pastes the string into the agent. The agent processes the prompt and its response is naturally appended to its internal local transcript (`.jsonl` or `.sqlite`).

### Step 4: Transcript Discovery (Grep)
Relay's backend daemon continuously scans the known global storage directories for the respective agents (e.g., `~/.claude/projects/`, `~/.codex/sessions/`, `.gemini/antigravity-ide/brain/`).
It searches (greps) for the unique `RELAY_INIT_HANDSHAKE` token.

### Step 5: Persistent Mapping
Once the token is found, Relay securely maps that specific transcript file's path to the current workspace in its database. 
From that moment forward, Relay maintains a live, persistent read-connection to that specific transcript file to stream memory, activity, and thoughts into the Mission Control dashboard in real-time.
