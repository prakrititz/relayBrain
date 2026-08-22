"use client";

import { usePanes, type PanePreset } from "@/lib/panes";
import ui from "@/styles/ui.module.css";

/* A 3-chamber diagram: the frame is the workspace, a filled block is a visible
   side chamber, the middle is always the center. Geometry only — no glyphs. */
function LayoutIcon({ left, right }: { left: boolean; right: boolean }) {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden focusable="false">
      <rect x="0.75" y="0.75" width="16.5" height="12.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      {left ? (
        <>
          <rect x="1.75" y="1.75" width="4" height="10.5" rx="1" fill="currentColor" />
          <line x1="5.75" y1="1" x2="5.75" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.5" />
        </>
      ) : null}
      {right ? (
        <>
          <rect x="12.25" y="1.75" width="4" height="10.5" rx="1" fill="currentColor" />
          <line x1="12.25" y1="1" x2="12.25" y2="13" stroke="currentColor" strokeWidth="1" opacity="0.5" />
        </>
      ) : null}
    </svg>
  );
}

const PRESETS: { id: PanePreset; left: boolean; right: boolean; label: string }[] = [
  { id: "all", left: true, right: true, label: "Layout: all three panels" },
  { id: "left", left: true, right: false, label: "Layout: workspace + center" },
  { id: "right", left: false, right: true, label: "Layout: center + details" },
  { id: "center", left: false, right: false, label: "Layout: center only" },
];

export function LayoutSwitcher() {
  const { preset, setPreset } = usePanes();
  return (
    <div className={ui.layoutSwitch} role="group" aria-label="Workspace layout">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`${ui.layoutBtn} ${preset === p.id ? ui.layoutBtnOn : ""}`}
          onClick={() => setPreset(p.id)}
          title={p.label}
          aria-label={p.label}
          aria-pressed={preset === p.id}
        >
          <LayoutIcon left={p.left} right={p.right} />
        </button>
      ))}
    </div>
  );
}
