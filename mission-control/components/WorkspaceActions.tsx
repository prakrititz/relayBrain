"use client";

import { useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import ui from "@/styles/ui.module.css";

export function WorkspaceActions({ projectId }: { projectId?: string | null }) {
  const { leaveWorkspace, removeWorkspace } = useRelay();
  const [hint, setHint] = useState("");
  const id = projectId;
  if (!id) return null;

  const run = async (fn: (id: string) => Promise<{ ok: boolean; hint?: string }>) => {
    setHint("");
    const result = await fn(id);
    if (!result.ok) setHint(result.hint || "Could not update workspace.");
  };

  return (
    <div className={ui.actions} style={{ justifyContent: "flex-start", marginTop: 10, flexWrap: "wrap" }}>
      <button className={`${ui.chip} ${ui.ghost}`} onClick={() => run(leaveWorkspace)}>
        Leave workspace
      </button>
      <button className={`${ui.chip} ${ui.ghost}`} onClick={() => run(removeWorkspace)}>
        Remove from Relay
      </button>
      {hint ? <p style={{ color: "var(--amber)", width: "100%", margin: "8px 0 0" }}>{hint}</p> : null}
    </div>
  );
}
