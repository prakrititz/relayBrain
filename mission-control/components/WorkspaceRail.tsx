"use client";

import { useEffect, useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import ui from "@/styles/ui.module.css";

// Workspace tiles are filled with the project's own colour, so the initials
// have to flip between black and white to stay readable on it.
function inkFor(hex?: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // Perceived brightness (ITU-R BT.601)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#000000" : "#ffffff";
}

// Workspaces only. The account/profile block lives in the top navbar.
export function WorkspaceRail() {
  const { projects, dashboard, selectedProjectId, selectProject, setAddOpen, leaveWorkspace, removeWorkspace } =
    useRelay();
  const activeId = selectedProjectId || dashboard?.project.id;
  const [menuId, setMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuId]);

  return (
    <aside className={ui.rail}>
      {projects.map((p) => (
        <button
          key={p.id}
          className={`${ui.wsBtn} ${activeId === p.id ? ui.active : ""}`}
          style={{ background: p.color, color: inkFor(p.color) }}
          title={`${p.name} — right-click for options`}
          onClick={() => selectProject(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuId(p.id);
          }}
        >
          {p.initials}
        </button>
      ))}

      {menuId ? (
        <div className={ui.menu} style={{ left: 68, top: 68, bottom: "auto" }} onClick={(e) => e.stopPropagation()}>
          <h4>Workspace</h4>
          <button className={ui.row} onClick={() => { void leaveWorkspace(menuId); setMenuId(null); }}>
            Leave workspace
          </button>
          <button className={ui.row} onClick={() => { void removeWorkspace(menuId); setMenuId(null); }}>
            Remove from Relay
          </button>
          <button className={ui.row} onClick={() => setMenuId(null)}>
            Cancel
          </button>
        </div>
      ) : null}

      <button className={ui.addBtn} title="Add workspace" onClick={() => setAddOpen(true)}>
        +
      </button>
    </aside>
  );
}
