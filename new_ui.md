UI Component Spec — Mesh

Shared Brain for AI-Assisted Teams. Bring Your Own Agent.


What This Product Actually Is

One persistent memory + collaboration layer that sits above every AI coding tool.
Claude Code, Copilot, Codex, Cursor — doesn't matter. You bring your credits, your tool, your workflow.
Mesh gives your whole team one shared brain, live presence, and a decision feed everyone can vote on.

One line: "Your AI knows what you know. Now it knows what your whole team knows."


Layout (Keep the Shell, Change the Soul)

The existing 3-panel layout is correct. What changes is what each panel means.

┌─────────────────────────────────────────────────────────────────────┐
│  MESH   [workspace: GoalGuard]  ▼      ● 3 online    [+ Invite]    │
├──────────────┬──────────────────────────────┬───────────────────────┤
│              │                              │                       │
│  TEAMMATES   │   CONVERSATION / CHAT        │   SHARED MEMORY       │
│  + their     │   (keep this — it's good)    │   BANK                │
│  agents      │                              │                       │
│              │                              │                       │
├──────────────┼──────────────────────────────┼───────────────────────┤
│              │                              │                       │
│  MEMORY      │   ACTIVITY STREAM            │   PENDING             │
│  PROPOSALS   │   (what everyone is doing    │   VOTES               │
│  QUEUE       │    right now)                │                       │
│              │                              │                       │
├──────────────┴──────────────────────────────┴───────────────────────┤
│         CONNECTED TOOLS BAR  (Claude Code ● Copilot ○ Codex ●)     │
└─────────────────────────────────────────────────────────────────────┘

Chat stays as the center column — this is correct. It's where you talk to teammates AND query the shared memory ("did Pony fix the auth bug?"). The AI responds from shared memory context.


1. HEADER — Replace DevSecOps chrome

Current: "DevSecOps" title, "SYSTEM ONLINE" badge, random icons

Replace with:

[Mesh logo]  GoalGuard  ▼    ● Pony  ● Unnath  ● Arjun    [+ Invite]    [Memory: 847 entries]    [Settings]


Workspace name + switcher dropdown
Live avatar dots for online teammates (not agent names — real people)
Memory entry counter (psychological signal — shows the brain is growing)
No "SYSTEM ONLINE" — replace with subtle ● workspace active in muted text



2. LEFT PANEL — Teammates + Their Agents (replaces "Active Agents")

Current: 4 agent cards (Architect, Developer, Security, Deployment) with STANDBY/DEPLOYING status

Replace with: Teammate cards showing the person + which AI tool they're currently using

┌─────────────────────────────────┐
│  TEAMMATES                      │
├─────────────────────────────────┤
│                                 │
│  🟢  Pony                       │
│      Claude Code  •  CODING     │
│      /src/auth/jwt.ts           │
│      "working on token refresh" │
│                                 │
│  🟢  Unnath                     │
│      Copilot  •  REVIEWING      │
│      /api/routes/users.ts       │
│                                 │
│  🟡  Arjun                      │
│      Codex  •  IDLE             │
│      last seen 4m ago           │
│                                 │
│  ⚪  Sakshi                     │
│      OFFLINE                    │
│                                 │
└─────────────────────────────────┘

Key details:


Show which AI tool each person is using (Claude Code / Copilot / Codex / Cursor / custom)
Show which file they're currently in (pulled from their agent's active context)
Status: CODING (green pulse) / REVIEWING / IDLE / OFFLINE
Click a teammate → see their last 5 memory contributions + what their AI is working on
Status dot colors: green = active last 2min, yellow = idle 2-10min, grey = offline


This is the multiplayer presence layer. This alone makes it feel like Figma for coding.


3. CENTER PANEL — Chat (Keep, Modify Purpose)

Current: Discord-style chat where agents post reasoning cards

Keep the format, change who's talking:

The chat is now a hybrid of:


Teammate messages (humans talking)
Memory query responses (ask the shared brain anything)
Agent reasoning cards (when YOUR agent makes a decision, it posts a card here for the team to see)


Memory query example:

Pony  10:03 AM
did anyone set up rate limiting for the API?

🧠 Mesh Memory  10:03 AM
Yes — Unnath added this 2 days ago.
  KEY:    api/rate_limiting
  VALUE:  express-rate-limit, 100 req/min per IP
  ADDED:  Unnath via Copilot  •  Jun 10 14:22
  VOTES:  3 ✅  0 ❌
  [View full entry]

Agent decision card (modified from current design):

┌──────────────────────────────────────────────────┐
│  🤖 PONY'S AGENT (Claude Code)      10:04 AM     │
│  ─────────────────────────────────────────────   │
│  DECISION:  Use JWT over sessions                │
│  REASON:    Stateless, better for mobile clients │
│  AFFECTS:   /src/auth/* (4 files)               │
│                                                  │
│  💾 Save to shared memory?                       │
│  [✅ Save]  [❌ Skip]  [✏️ Edit before saving]   │
└──────────────────────────────────────────────────┘

This is the core loop — agent makes a decision → asks team if it should be remembered → team votes → memory updates for everyone.


4. RIGHT PANEL TOP — Shared Memory Bank (replaces blank space)

Current: Nothing useful in right panel

Replace with: File-tree view of shared memory

SHARED MEMORY BANK              [847 entries]  [Search...]
─────────────────────────────────────────────────────────
/
├── 📁 architecture
│     ├── stack: NextJS + Postgres + Redis     Pony  2d ago
│     ├── auth: JWT (stateless)                Pony  1h ago  ← NEW
│     └── deployment: blue-green              Unnath 3d ago
│
├── 📁 conventions
│     ├── code_style: functional, no classes   Arjun  5d ago
│     ├── branch_naming: feat/fix/chore        Unnath 5d ago
│     └── test_coverage_min: 80%              Unnath 5d ago
│
├── 📁 decisions
│     ├── #47 Use Redis for session cache      Pony   1d ago
│     ├── #46 Migrate to Postgres 15           Arjun  2d ago
│     └── #45 Drop websockets, use SSE         Pony   3d ago
│
├── 📁 bugs_fixed
│     ├── auth_refresh_loop → fixed by Pony    1h ago  🔴 RECENT
│     └── rate_limit_bypass → fixed by Unnath  4h ago
│
└── 📁 open_questions
      └── should we use tRPC or REST?          UNRESOLVED ⚠️

Interactions:


Click any entry → see full value, who wrote it, which tool wrote it, vote history
[Search...] → natural language search across all memory ("how do we handle errors?")
New entries flash briefly with a highlight before settling
← NEW badge on recently added entries
🔴 RECENT on entries added in last hour



5. RIGHT PANEL BOTTOM — Pending Votes (replaces nothing)

Current: "EXECUTION PLAN" label with no content

Replace with: Active vote queue

PENDING VOTES                               [3 open]
─────────────────────────────────────────────────────
┌──────────────────────────────────────────────────┐
│  #48  Use tRPC instead of REST              NEW  │
│  Proposed by Arjun via Codex  •  2m ago          │
│  "Better type safety end-to-end"                 │
│  ✅ 1  ❌ 0  👁️ 2 seen                          │
│  [✅ Agree]  [❌ Disagree]  [💬 Comment]         │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  #47  Increase rate limit to 200 req/min         │
│  Proposed by Unnath via Copilot  •  14m ago      │
│  ✅ 2  ❌ 1  — closes in 2h                      │
│  [✅ Agree]  [❌ Disagree]  [💬 Comment]         │
└──────────────────────────────────────────────────┘

Vote resolution logic (gimmick version):


Majority after 3 votes OR after 24h → auto-commits to shared memory
Rejected → archived with reason
Notifications sent to all teammates when a vote resolves



6. LEFT PANEL BOTTOM — Memory Proposals Queue

Below the teammate list:

RECENT MEMORY ACTIVITY
─────────────────────────────────
⟳  Pony's agent proposed #48
   "JWT auth approach"   2m ago

✅  #46 committed to memory
   "Postgres migration"  1h ago

❌  #44 rejected (2-1 vote)
   "Use MongoDB"         3h ago

💬  Unnath commented on #47
   "we should test first" 4h ago

Simple feed. Keeps everyone in sync without needing to watch the chat.


7. BOTTOM BAR — Connected Tools (replaces Infrastructure Layer)

Current: Nothing

Replace with: Which AI tools are connected to this workspace

CONNECTED TOOLS

[🟢 Claude Code  Pony]   [🟢 Copilot  Unnath]   [🟢 Codex  Arjun]   [⚪ Cursor  —]   [+ Connect Your Tool]


Green dot = someone on the team is actively using it right now
Grey = supported but no one connected
Click + Connect Your Tool → shows setup instructions for each supported tool (VS Code extension, CLI hook, etc.)
Each pill shows which teammate is using it


This is the BYOA (Bring Your Own Agent) pitch made visual. One glance tells you "this works with whatever you already have."


8. ACTIVITY STREAM — Center Panel Secondary View

A tab in the center panel (next to the chat tab):

[💬 Chat]  [📡 Activity]  [🧠 Memory Search]

Activity tab — Vercel-style log of everything happening across the workspace:

[10:04:12]  🟢 Pony        Claude Code wrote to memory: "JWT auth approach"
[10:04:08]  🟢 Pony        opened /src/auth/jwt.ts
[10:03:55]  🟢 Unnath      voted ✅ on proposal #47
[10:03:31]  🤖 Arjun/Codex proposed memory entry #48: "tRPC vs REST"
[10:03:12]  🟢 Arjun       opened /api/routes/users.ts
[10:02:44]  ✅ MEMORY      #46 committed — "Postgres 15 migration"
[10:01:33]  🟢 Unnath      joined workspace
[10:00:12]  🤖 Pony/Claude Decision: JWT over sessions (confidence 94%)

Color coding:


🟢 human action → white
🤖 agent action → blue/purple
✅ memory commit → green
❌ memory rejected → red muted
⚠️ conflict detected → amber



9. MEMORY SEARCH TAB

Third tab in center panel. Natural language search across all shared memory.

🧠 Ask the shared brain...

[  did we decide on a state management library?         ] [Ask]

─────────────────────────────────────────────────────────────
MESH MEMORY ANSWER

No decision has been committed yet.

Related open question:
  #43  "Zustand vs Redux vs Context?"
  Proposed by Pony  •  2 days ago  •  UNRESOLVED ⚠️
  [View]  [Vote to resolve]

Related activity:
  Pony mentioned "Zustand" in chat  •  Jun 9
  Unnath used Redux in /src/store/  •  Jun 8

This is the killer feature for demos. You literally ask it a question about your codebase and it tells you what your team decided. If it's unresolved, it surfaces the open question.


10. GLOBAL HEADER — What to Actually Show

[Mesh]   GoalGuard ▼    ● Pony  ● Unnath  ● Arjun     🧠 847 memories    ⚡ 3 votes pending    [Settings]


No token counter (that's per-person, per-tool — not Mesh's concern)
Memory count is the growth signal (going up = system is learning)
Pending votes badge is the action signal (something needs your attention)
Online teammate avatars always visible



11. VISUAL CHANGES FROM CURRENT SCREENSHOT

Keep:


Dark theme, overall color palette
3-panel layout
Reasoning card format (repurposed as memory proposal cards)
Channel sidebar concept (repurposed as workspace/project switcher)


Change:


"DevSecOps" → "Mesh" (or your product name)
Agent names (Architect, Developer...) → teammate names + tool badges
"STANDBY/DEPLOYING" status → "CODING/REVIEWING/IDLE/OFFLINE"
Right panel empty state → Memory Bank file tree
Bottom "EXECUTION PLAN" stub → Pending Votes queue
Add bottom tools bar
Add tab switcher in center panel (Chat / Activity / Memory Search)


Typography (same as before):


JetBrains Mono for memory entries, activity stream, code snippets
Inter for all UI chrome, labels, teammate names
Section labels: 10px uppercase tracking-widest opacity-40


Color additions for new states:


--color-memory-new → #6366f1 (indigo — new memory entry highlight)
--color-vote-open → #f59e0b (amber — pending vote)
--color-vote-yes → #22c55e (green)
--color-vote-no → #ef4444 (red)
--color-teammate-active → #22c55e pulse
--color-agent-action → #818cf8 (purple — AI did something)



12. THE DEMO FLOW (5-day hackathon closer)

This is what you show on demo day, in order:


Open workspace — 3 teammates online, memory bank has 847 entries
Type in chat: "did we decide on auth?" → Memory instantly answers with Pony's JWT decision
Pony's Claude Code proposes a new memory entry live → card appears in chat
Unnath (different tool, Copilot) sees it and votes ✅ from their side
Vote resolves → memory commits → Activity stream updates for everyone
New teammate joins → their Codex immediately has full context of all 847 decisions
Ask: "what's unresolved?" → surfaces 2 open questions with vote buttons


The punchline you say to judges:


"Replit costs $25/month and locks your team to one tool. We don't care what AI you use. Bring your Claude Code credits, your Copilot subscription, whatever. We just make your whole team share one brain. And when someone new joins, they're up to speed in 30 seconds."




BUILD PRIORITY FOR 5 DAYS

DayWhat to build1Memory schema + storage (Supabase/Postgres). What a memory entry is: key, value, proposedBy, tool, votes, timestamp2Chat UI with memory query ("did X happen?") — fake the AI response with hardcoded answers for demo3Teammate presence panel + live activity stream (can be fake/timer-driven)4Vote cards in chat + vote resolution flow5Polish: bottom tools bar, memory file tree, demo script rehearsal

You do NOT need real integrations with Claude Code/Copilot for the hackathon. Show the UI, fake the memory writes with demo data, nail the demo flow. The concept sells itself.


The chat UI you built isn't the product. It's the interface to a shared brain. That's a completely different thing — and nobody has built it yet.