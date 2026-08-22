"use client";

import { useRelay } from "@/lib/RelayContext";
import { plainPreview } from "@/lib/markdown";
import ui from "@/styles/ui.module.css";

export function RightRail() {
  const { dashboard } = useRelay();
  if (!dashboard) return <aside className={ui.right} />;
  const latest = (dashboard.history || []).slice(-1)[0] || dashboard.timeline[0];
  const lastChat = dashboard.chats[0];
  const preview = latest ? plainPreview(latest.text, 160) : "";
  return (
    <aside className={ui.right}>
      <section>
        <div className={ui.kicker}>People</div>
        <div className={ui.tags}>
          {dashboard.collaborators.length ? (
            dashboard.collaborators.map((c) => (
              <div key={c.id} className={`${ui.person} ${c.agentActive ? ui.active : ""}`} title={c.online ? "online" : "offline"}>
                <img src={c.avatarUrl} alt="" />
                <span>{c.name}</span>
              </div>
            ))
          ) : (
            <p style={{ color: "var(--muted)" }}>Just you</p>
          )}
        </div>
      </section>
      <section>
        <div className={ui.kicker}>Latest</div>
        {latest ? (
          <p className={ui.clamp}>
            <strong>{latest.agent}</strong> — {preview}
          </p>
        ) : (
          <p style={{ color: "var(--muted)" }}>Nothing synced yet</p>
        )}
        {lastChat ? <p className={ui.clamp} style={{ color: "var(--muted)" }}>{plainPreview(lastChat.messages.slice(-1)[0]?.text || "", 160)}</p> : null}
      </section>
      <section>
        <div className={ui.kicker}>Memory</div>
        <p>
          {dashboard.memory?.historyCount ?? dashboard.history?.length ?? 0} events · {dashboard.memory?.chatCount ?? 0} chats · {dashboard.memory?.editCount ?? 0} edits
          {(dashboard.conflicts || []).length ? ` · ${dashboard.conflicts.length} overlap(s)` : ""}
        </p>
      </section>
    </aside>
  );
}
