UI Modification & Implementation Prompt
Context & Goal
We are building a "GitHub Desktop for AI Agents." The system operates as an event-triggered, repo-centric dashboard where multiple users and their respective agents collaborate on shared repositories. I have an existing UI (refer to image_60c283.jpg) that needs architectural and visual modifications to support this cross-user, multi-agent workflow.

The backend relies on pre-tool use hooks (or an MCP solution) so that agents (like Claude) consult a coordinator before editing files, meaning there is no busy-waiting. All agent chat history, file edits, and JSON transcripts are shared across all users active on the same repository.

Please update the frontend code to reflect the following structural and state-driven changes:

1. Authentication & User Scope (Top-Left)

Current State: The top-left corner shows a simple dropdown with ./relay and user1.

Modification: Convert this into a robust GitHub Account / Profile Switcher.

Functionality: It should allow the user to log in and log out via GitHub webhooks. When logged in, it should display their GitHub avatar/username. Logging in as different users should dynamically fetch their respective access rights and repos.

2. Workspace / Repository Navigation (Far-Left Sidebar)

Current State: There is a far-left sidebar with circular icons ("US", "US", and a "+").

Modification: Define these circular icons as Workspaces (GitHub Repositories).

Functionality: Clicking between them should completely swap the dashboard's context (connected agents, recent activity, IR files, etc. must be strictly unique to the active repo).

The "+" Action: Wiring up the "+" button should open a modal offering two distinct onboarding options, similar to GitHub Desktop:

Relay Clone: A combined git clone + relay init command to pull a remote repository and immediately initialize the shared agent context.

Add Local Repository: Allow the user to select an existing local folder/repository from their hard drive and initialize the Relay agent context for it.

3. Collaborators Presence (Middle-Right Section)

Current State: The "COLLABORATORS" widget displays tags for Unnat, Prakrititz, Krishna, Gathik, and Hemanth.

Modification: Enhance this widget to serve as a real-time presence indicator.

Functionality: Show which collaborators are currently active in the selected repository. Since this is a shared environment, indicate if a collaborator's agent is currently executing a task on the repo (e.g., adding a pulsing ring or "Agent Active" badge next to their avatar).

4. Data Scoping & Event-Driven UI Updates

Strict Repo Isolation: Ensure the state management (React Context, Redux, or Zustand) scopes the entire view to the active workspace. The Agent Integrations (left sidebar), Recent Agent Activity, Handoff / Project, and Relay Brain panels must immediately re-render with repo-specific data when a new workspace is clicked.

Shared Context Visualization: Add a visual indicator (perhaps a small badge in the Agent Integrations or Recent Agent Activity areas) when an action was performed by another user's agent vs. your own agent.

Technical Constraints

Maintain the existing dark mode aesthetic, typography, and layout dimensions shown in image_60c283.jpg.

Write the state management logic to expect event-driven WebSocket or Server-Sent Events (SSE) updates, avoiding polling (no busy-waiting), as the backend coordinates locks and file edits via hooks.