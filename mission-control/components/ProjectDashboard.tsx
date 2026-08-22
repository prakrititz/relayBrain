"use client";

import { useRelay } from "@/lib/RelayContext";
import type { TabId } from "@/lib/types";
import { ActivityTimeline } from "./ActivityTimeline";
import { AgentSessionChat } from "./AgentSessionChat";
import { CodeEdits } from "./CodeEdits";
import { LayoutSwitcher } from "./LayoutSwitcher";
import { FileLocksPanel } from "./FileLocksPanel";
import { TeamPanel } from "./TeamPanel";
import { MemoryPanel } from "./MemoryPanel";
import { SettingsPanel } from "./SettingsPanel";
import ui from "@/styles/ui.module.css";

const TABS: { id: TabId; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "chat", label: "Agent Chat" },
  { id: "edits", label: "Code Edits" },
  { id: "locks", label: "Coordinator" },
  { id: "team", label: "Team" },
  { id: "memory", label: "Memory" },
];

export function ProjectDashboard() {
  const { tab, setTab, notices } = useRelay();
  const inviteUnread = notices.filter((n) => n.type === "invite" && !n.readAt).length;
  return (
    <div className={ui.workspace}>
      <div className={ui.tabsBar}>
        <nav className={ui.tabs}>
          {TABS.map((t) => (
            <button key={t.id} className={`${ui.tab} ${tab === t.id ? ui.active : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "team" && inviteUnread ? <span className={ui.tabBadge}>{inviteUnread}</span> : null}
            </button>
          ))}
        </nav>
        <div className={ui.tabsBarEnd}>
          <LayoutSwitcher />
        </div>
      </div>
      <div className={ui.panelWrap}>
        <div className={ui.panelScroll}>
          {tab === "activity" && <ActivityTimeline />}
          {tab === "chat" && <AgentSessionChat />}
          {tab === "edits" && <CodeEdits />}
          {tab === "locks" && <FileLocksPanel />}
          {tab === "team" && <TeamPanel />}
          {tab === "memory" && <MemoryPanel />}
          {tab === "settings" && <SettingsPanel />}
        </div>
        <div className={ui.panelFade} />
      </div>
    </div>
  );
}
