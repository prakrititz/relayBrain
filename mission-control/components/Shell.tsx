"use client";

import type { CSSProperties } from "react";
import { WorkspaceRail } from "./WorkspaceRail";
import { Sidebar } from "./Sidebar";
import { TopNavbar } from "./TopNavbar";
import { ProjectDashboard } from "./ProjectDashboard";
import { RightRail } from "./RightRail";
import { AddWorkspaceWindow } from "./AddWorkspaceWindow";
import { NoticeToasts } from "./NoticeCenter";
import { PanesProvider, usePanes } from "@/lib/panes";
import ui from "@/styles/ui.module.css";

/** The 1px divider is the chamber's own border; this is just the grab zone. */
function PaneHandle({ side }: { side: "left" | "right" }) {
  const { startDrag, nudge, reset, dragging } = usePanes();
  const pos =
    side === "left"
      ? { left: "calc(var(--rail-w) + var(--pane-left) - 3px)" }
      : { right: "calc(var(--pane-right) - 3px)" };
  return (
    <div
      className={`${ui.paneHandle} ${dragging === side ? ui.paneHandleActive : ""}`}
      style={pos as CSSProperties}
      onPointerDown={(e) => startDrag(side, e)}
      onDoubleClick={() => reset(side)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") nudge(side, side === "left" ? -16 : 16);
        else if (e.key === "ArrowRight") nudge(side, side === "left" ? 16 : -16);
        else return;
        e.preventDefault();
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? "Resize workspace panel" : "Resize details panel"}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
    />
  );
}

function ShellInner() {
  const { left, right, leftOpen, rightOpen, dragging } = usePanes();
  const style = {
    "--rail-w": "60px",
    "--pane-left": leftOpen ? `${left}px` : "0px",
    "--pane-right": rightOpen ? `${right}px` : "0px",
  } as CSSProperties;

  return (
    <div
      className={`${ui.app} ${leftOpen ? "" : ui.paneLeftClosed} ${rightOpen ? "" : ui.paneRightClosed} ${dragging ? ui.paneDragging : ""}`}
      style={style}
    >
      <TopNavbar />
      <WorkspaceRail />
      <Sidebar />
      <div className={ui.main}>
        <div className={ui.body}>
          <ProjectDashboard />
          <RightRail />
        </div>
      </div>
      {leftOpen ? <PaneHandle side="left" /> : null}
      {rightOpen ? <PaneHandle side="right" /> : null}
      <AddWorkspaceWindow />
      <NoticeToasts />
    </div>
  );
}

export function Shell() {
  return (
    <PanesProvider>
      <ShellInner />
    </PanesProvider>
  );
}
