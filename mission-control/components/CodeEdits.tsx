"use client";

import { useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import ui from "@/styles/ui.module.css";

function Diff({ text }: { text: string }) {
  const lines = text.split("\n").slice(0, 80);
  return (
    <div className={ui.diff}>
      {lines.map((line, i) => (
        <div key={i} className={line.startsWith("+") ? ui.add : line.startsWith("-") ? ui.del : ""}>
          {line}
        </div>
      ))}
    </div>
  );
}

export function CodeEdits() {
  const { dashboard, rewind } = useRelay();
  const patches = dashboard?.patches?.length ? dashboard.patches : dashboard?.edits || [];
  const maxLamport = Math.max(0, ...patches.map((p) => p.lamport || 0));
  const [cursor, setCursor] = useState(dashboard?.lastAppliedLamport || maxLamport);

  if (!patches.length) return <div className={ui.empty}>No patches in this workspace.</div>;

  return (
    <>
      <article className={ui.card}>
        <h3>Time travel</h3>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Lamport-ordered micro-patches. Drag to rewind the working tree to that causal cut.
        </p>
        <input
          className={ui.slider}
          type="range"
          min={0}
          max={maxLamport}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
        />
        <div className={ui.rowBetween}>
          <span>Lamport {cursor}</span>
          <button className={ui.syncBtn} onClick={() => rewind(cursor)}>
            Rewind
          </button>
        </div>
      </article>
      {patches.map((edit) => (
        <details className={ui.card} key={edit.id}>
          <summary className={ui.rowBetween}>
            <h3>
              {edit.file}
              {edit.lamport != null ? ` · L${edit.lamport}` : ""}
              {edit.binary ? " · binary SHA" : ""}
            </h3>
            <span className={edit.mine ? `${ui.badge} ${ui.mine}` : `${ui.badge} ${ui.theirs}`}>
              {edit.agent} · {edit.mine ? "you" : `@${edit.ownerLogin}`}
            </span>
          </summary>
          <div style={{ marginTop: 10 }}>
            <Diff text={edit.diff} />
          </div>
        </details>
      ))}
    </>
  );
}
