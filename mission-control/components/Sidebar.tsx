"use client";

import { useRelay } from "@/lib/RelayContext";
import type { Agent } from "@/lib/types";
import ui from "@/styles/ui.module.css";

function timeAgo(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

// Brand icon + the accent colour each agent contributes to the UI.
const AGENTS: { match: string[]; src: string; ring: string }[] = [
  { match: ["cursor"], src: "/agents/cursor.png", ring: "agentCursor" },
  { match: ["claude"], src: "/agents/claude.png", ring: "agentClaude" },
  { match: ["codex", "openai"], src: "/agents/codex.png", ring: "agentCodex" },
  { match: ["copilot"], src: "/agents/copilot.png", ring: "agentCopilot" },
  { match: ["antigravity", "gemini"], src: "/agents/antigravity.png", ring: "agentAntigravity" },
];

export function agentBrand(label: string) {
  const l = String(label || "").toLowerCase();
  return AGENTS.find((a) => a.match.some((m) => l.includes(m))) || null;
}

function AgentRow({ agent }: { agent: Agent }) {
  const { handshake, user } = useRelay();
  const mine = !agent.ownerLogin || agent.ownerLogin === user?.login;
  const label =
    agent.status === "connected" ? "Connected" : agent.status === "handshaking" ? "Connecting…" : "Connect";
  const brand = agentBrand(agent.label);
  const statusClass =
    agent.status === "connected"
      ? ui.connected
      : agent.status === "handshaking"
        ? ui.handshaking
        : agent.status === "error"
          ? ui.error
          : "";

  return (
    <div className={ui.agentRow}>
      <span className={ui.agentIconWrap}>
        {brand ? (
          <img src={brand.src} alt="" className={`${ui.agentIcon} ${ui[brand.ring]}`} />
        ) : (
          <span className={ui.agentIconFallback}>{agent.label?.[0]?.toUpperCase() || "?"}</span>
        )}
        <span className={`${ui.agentIconDot} ${statusClass}`} />
      </span>
      <div className={ui.agentMeta}>
        <strong>{agent.label}</strong>
        <span>
          {mine ? "your agent" : `@${agent.ownerLogin}`}
          {agent.sessionId && agent.status === "connected" ? ` · ${agent.sessionId}` : ""}
        </span>
      </div>
      {!mine && <span className={`${ui.badge} ${ui.theirs}`}>theirs</span>}
      <button
        className={`${ui.chip} ${agent.status === "connected" ? "" : ui.ghost}`}
        onClick={() => handshake(agent)}
        disabled={agent.status === "handshaking"}
      >
        {label}
      </button>
    </div>
  );
}

export function Sidebar() {
  const { dashboard, projects, selectedProjectId } = useRelay();
  const project = projects.find((p) => p.id === selectedProjectId) || dashboard?.project;
  const live = dashboard && dashboard.project.id === selectedProjectId ? dashboard : null;
  if (!live && !project) return <aside className={ui.sidebar} />;

  const agents = live?.agents || [];
  const activity = live?.activity || [];

  return (
    <aside className={ui.sidebar}>
      <div className={ui.sideHead}>
        <div className={ui.kicker}>Workspace</div>
        <h2>{project?.name || live?.project.name}</h2>
      </div>
      <div className={ui.sideScroll}>
        <div className={ui.sectionHead}>
          <span className={ui.kicker}>Agent integrations</span>
          <span className={ui.sectionCount}>{agents.length}</span>
        </div>
        {agents.length === 0 ? (
          <div className={ui.sectionEmpty}>No agents registered for this workspace yet.</div>
        ) : (
          agents.map((a) => <AgentRow key={`${a.ownerLogin || "local"}:${a.id}`} agent={a} />)
        )}

        <div className={ui.sectionHead}>
          <span className={ui.kicker}>Recent agent activity</span>
          <span className={ui.sectionCount}>{activity.length}</span>
        </div>
        {activity.length === 0 ? (
          <div className={ui.sectionEmpty}>Nothing yet — agent edits show up here as they happen.</div>
        ) : (
          activity.map((item) => (
            <div className={ui.activityItem} key={item.id}>
              <span>{item.kind === "edit" ? "✎" : item.kind === "plan" ? "◆" : "•"}</span>
              <p>
                <strong>{item.agent}</strong> {item.text}{" "}
                {!item.mine && <span className={`${ui.badge} ${ui.theirs}`}>@{item.ownerLogin}</span>}
                {item.mine && <span className={`${ui.badge} ${ui.mine}`}>you</span>}
              </p>
              <small>{timeAgo(item.ts)}</small>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
