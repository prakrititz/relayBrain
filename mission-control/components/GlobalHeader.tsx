"use client";

import { useEffect, useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import ui from "@/styles/ui.module.css";

function fetchedLabel(ts: number | null, now: number) {
  if (!ts) return "Not fetched";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 2) return "Just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function GlobalHeader() {
  const { dashboard, projects, selectedProjectId, sync, syncing, lastFetchedAt } = useRelay();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const project = projects.find((p) => p.id === selectedProjectId) || dashboard?.project;
  if (!project) return <header className={ui.header} />;
  const fetched = lastFetchedAt || dashboard?.memory?.lastTranscriptSyncAt || project.lastSyncAt || null;
  return (
    <header className={ui.header}>
      <div>
        <h1>{project.name}</h1>
        <div className={ui.path}>{project.path}</div>
      </div>
      <div className={ui.syncCluster}>
        <span className={`${ui.syncMeta} ${syncing ? ui.syncLive : ""}`}>
          {syncing ? "Syncing…" : `Fetched ${fetchedLabel(fetched, now)}`}
        </span>
        <button className={ui.syncBtn} onClick={sync} disabled={syncing}>
          Sync
        </button>
      </div>
    </header>
  );
}
