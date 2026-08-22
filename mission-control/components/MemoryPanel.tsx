"use client";

import { useRelay } from "@/lib/RelayContext";
import { MarkdownView, plainPreview } from "@/lib/markdown";
import ui from "@/styles/ui.module.css";

export function MemoryPanel() {
  const { dashboard } = useRelay();
  if (!dashboard) return null;
  return (
    <>
      <article className={ui.card}>
        <h3>memory.json</h3>
        <p style={{ color: "var(--muted)", margin: "4px 0 0" }}>
          {dashboard.memory?.historyCount ?? dashboard.history?.length ?? 0} events · {dashboard.memory?.chatCount ?? dashboard.chats.length} chats · {dashboard.memory?.editCount ?? dashboard.edits.length} edits
        </p>
      </article>
      {(dashboard.conflicts || []).map((c) => (
        <article className={ui.card} key={c.file}>
          <h3>Conflict · {c.file}</h3>
          <p style={{ color: "var(--amber)", margin: "4px 0 0" }}>{c.agents.join(" + ")}</p>
        </article>
      ))}
      {dashboard.timeline.slice(0, 12).map((seg) => (
        <details className={ui.card} key={seg.id}>
          <summary className={ui.rowBetween}>
            <h3>{seg.agent} · {seg.events.length}</h3>
            <span className={seg.mine ? `${ui.badge} ${ui.mine}` : `${ui.badge} ${ui.theirs}`}>{seg.mine ? "you" : `@${seg.ownerLogin}`}</span>
          </summary>
          <p className={ui.clamp} style={{ color: "var(--muted)", margin: "8px 0 0" }}>
            {seg.events.map((ev) => ev.file || plainPreview(ev.text || "", 80)).filter(Boolean).slice(0, 3).join(" · ")}
          </p>
          <ul className={ui.memList}>
            {seg.events.map((ev, i) => (
              <li key={i}>{ev.file ? ev.file : <MarkdownView text={ev.text || ""} />}</li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}
