"use client";

import { useRelay } from "@/lib/RelayContext";
import { WorkspaceActions } from "./WorkspaceActions";
import ui from "@/styles/ui.module.css";

export function SettingsPanel() {
  const { dashboard } = useRelay();
  if (!dashboard) return null;
  const p = dashboard.project;
  return (
    <article className={ui.card}>
      <h3>Project</h3>
      <p>Name: {p.name}</p>
      <p>
        Path: <code>{p.path}</code>
      </p>
      <p>Remote: {p.remoteUrl || "local"}</p>
      <p>
        API key: <code>{p.apiKey}</code>
      </p>
      <p>Events: {dashboard.stats.events ?? 0}</p>
      <p>Connected agents: {dashboard.agents.filter((a) => a.status === "connected").length}</p>
      <p>Last sync: {new Date(p.lastSyncAt).toLocaleString()}</p>
      <WorkspaceActions projectId={p.id} />
    </article>
  );
}
