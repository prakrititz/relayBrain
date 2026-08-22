"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap,
  Handle, Position, getBezierPath, useReactFlow,
  type Node, type Edge, type NodeProps, type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRelay } from "@/lib/RelayContext";
import { useLockGraph, type EdgeKind, type GFile, type GUser } from "./useLockGraph";
import g from "./lockgraph.module.css";

const GW = 250, AGENT_H = 66, GHEAD = 46, COL_X = 640, FILE_H = 100, GAP = 26;

function agentLogo(label: string) {
  const l = String(label || "").toLowerCase();
  if (l.includes("cursor")) return "/agents/cursor.png";
  if (l.includes("claude")) return "/agents/claude.png";
  if (l.includes("codex") || l.includes("openai")) return "/agents/codex.png";
  if (l.includes("copilot")) return "/agents/copilot.png";
  if (l.includes("antigravity") || l.includes("gemini")) return "/agents/antigravity.png";
  return null;
}

const STATE_TEXT: Record<string, { icon: string; text: string; cls: string }> = {
  hold: { icon: "●", text: "Editing now", cls: "stHold" },
  clash: { icon: "▲", text: "Editing now", cls: "stClash" },
  read: { icon: "◎", text: "Reading", cls: "stRead" },
  wait: { icon: "◐", text: "Also working here", cls: "stWait" },
  idle: { icon: "○", text: "Idle", cls: "stIdle" },
};

/* ------------------------------- nodes ------------------------------- */

function UserNode({ data }: NodeProps) {
  const d = data as unknown as GUser;
  return (
    <div className={g.ugroup}>
      <div className={g.uhead}>
        {d.avatarUrl
          ? <img className={g.uav} src={d.avatarUrl} alt="" />
          : <span className={g.uavFallback}>{d.login[0]?.toUpperCase()}</span>}
        <b>@{d.login}</b>
        <span className={d.online ? g.udotOn : g.udotOff} />
        <span className={g.ucount}>{d.agents.length}</span>
      </div>
    </div>
  );
}

function AgentNode({ data }: NodeProps) {
  const d = data as { label: string; state: string; host: string };
  const s = STATE_TEXT[d.state] || STATE_TEXT.idle;
  const logo = agentLogo(d.label);
  return (
    <div className={`${g.agent} ${d.state === "hold" ? g.agentOn : ""} ${d.state === "clash" ? g.agentClash : ""}`}>
      {logo ? <img src={logo} alt="" className={g.alogo} />
            : <span className={g.alogoFallback}>{d.label[0]?.toUpperCase()}</span>}
      <div className={g.am}>
        <div className={g.an} title={d.host ? `${d.label} · ${d.host}` : d.label}>{d.label}</div>
        <div className={`${g.as} ${g[s.cls]}`}>{s.icon} {s.text}</div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function FileNode({ data }: NodeProps) {
  const d = data as unknown as GFile;
  const R = 7.5, C = 2 * Math.PI * R;
  const clash = d.clashUsers.length > 1;
  return (
    <div className={`${g.file} ${clash ? g.fileClash : d.holder ? g.fileLocked : ""}`}>
      <Handle type="target" position={Position.Left} />
      <div className={g.fn}>
        <svg className={g.ring} viewBox="0 0 20 20" aria-hidden>
          <circle className={g.ringBg} cx="10" cy="10" r={R} />
          <circle cx="10" cy="10" r={R} fill="none" strokeWidth="2.5" strokeLinecap="round"
            stroke={clash ? "var(--clash)" : "var(--holding)"}
            strokeDasharray={C} strokeDashoffset={C * (1 - d.ttl)}
            style={{ transform: "rotate(-90deg)", transformOrigin: "50% 50%" }} />
        </svg>
        <span className={g.fname} title={d.path}>{d.path.split("/").pop()}</span>
        {clash ? <span className={`${g.pill} ${g.pClash}`}>⚠ {d.clashUsers.length} people</span>
          : d.waiting > 0 ? <span className={`${g.pill} ${g.pWait}`}>{d.waiting} more</span> : null}
      </div>
      <div className={g.fp}>{d.path}</div>
      <div className={g.who} style={clash ? { color: "var(--clash)" } : undefined}>
        {clash ? `${d.clashUsers.map((u) => "@" + u).join(" and ")} both editing`
          : d.holder ? `${d.holder} has it · ${d.secondsLeft}s left`
          : d.reader ? `${d.reader} is reading it`
          : "Not being edited"}
      </div>
    </div>
  );
}

/* ------------------------------- edge ------------------------------- */

function StateEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const kind = (data as { kind: EdgeKind }).kind;
  const animate = (data as { animate: boolean }).animate;
  const stop = kind === "wait" ? 52 : 6;   // a waiting line never reaches the file
  const [d] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX: targetX - stop, targetY, targetPosition,
  });
  const cls = kind === "hold" ? g.eHold : kind === "read" ? g.eRead : kind === "wait" ? g.eWait : g.eClash;
  const flowing = (kind === "hold" || kind === "clash") && animate;
  return (
    <>
      <path id={id} d={d} className={`${cls} ${flowing ? g.flowing : ""}`} fill="none" />
      {kind === "wait" && <circle cx={targetX - stop} cy={targetY} r="3" fill="var(--waiting)" />}
    </>
  );
}

const nodeTypes = { user: UserNode, agent: AgentNode, file: FileNode };
const edgeTypes = { state: StateEdge };

/* ------------------------------- board ------------------------------- */

function Board() {
  const { dashboard, user } = useRelay();
  const [now, setNow] = useState(() => Date.now());
  const [animate, setAnimate] = useState(true);
  const [showWaiting, setShowWaiting] = useState(true);
  const rf = useReactFlow();

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, []);

  const model = useLockGraph(dashboard, user, now);

  // Layout is keyed on the node SET, never on lock state — locks churn every few
  // seconds and a canvas that reflows on each is impossible to click.
  const layoutKey = useMemo(
    () => [
      ...model.users.map((u) => u.key + ":" + u.agents.map((a) => a.id).join(",")),
      ...model.files.map((f) => f.id),
    ].join("|"),
    [model.users, model.files]
  );

  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; h?: number }>();
    let y = 0;
    for (const u of model.users) {
      const h = GHEAD + Math.max(1, u.agents.length) * AGENT_H + 14;
      pos.set(u.key, { x: 0, y, h });
      u.agents.forEach((a, i) => pos.set(a.id, { x: 16, y: GHEAD + i * AGENT_H }));
      y += h + GAP;
    }
    model.files.forEach((f, i) => pos.set(f.id, { x: COL_X, y: i * (FILE_H + 16) }));
    return pos;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const nodes = useMemo<Node[]>(() => {
    const out: Node[] = [];
    for (const u of model.users) {
      const p = positions.get(u.key);
      if (!p) continue;
      out.push({
        id: u.key, type: "user", position: { x: p.x, y: p.y },
        data: u as unknown as Record<string, unknown>,
        style: { width: GW, height: p.h }, zIndex: 0,
      });
      for (const a of u.agents) {
        const ap = positions.get(a.id);
        if (!ap) continue;
        out.push({
          id: a.id, type: "agent", parentId: u.key, extent: "parent",
          position: { x: ap.x, y: ap.y },
          data: { label: a.label, state: a.state, host: a.host }, zIndex: 1,
        });
      }
    }
    for (const f of model.files) {
      const p = positions.get(f.id);
      if (!p) continue;
      out.push({ id: f.id, type: "file", position: { x: p.x, y: p.y }, data: f as unknown as Record<string, unknown>, zIndex: 1 });
    }
    return out;
  }, [model, positions]);

  const edges = useMemo<Edge[]>(
    () => model.edges
      .filter((e) => (showWaiting ? true : e.kind !== "wait"))
      .map((e) => ({ id: e.id, source: e.agentId, target: e.fileId, type: "state", data: { kind: e.kind, animate } })),
    [model.edges, animate, showWaiting]
  );

  useEffect(() => {
    const t = window.setTimeout(() => rf.fitView({ padding: 0.14, duration: 350 }), 80);
    return () => window.clearTimeout(t);
  }, [layoutKey, rf]);

  const clashes = model.files.filter((f) => f.clashUsers.length > 1).length;
  const holder = model.files.find((f) => f.holder && !f.clashUsers.length);
  const reader = model.files.find((f) => f.reader && !f.holder);
  const waiting = model.files.reduce((n, f) => n + f.waiting, 0);

  if (model.empty) {
    const room = dashboard?.room;
    // A guest whose host has gone quiet sees exactly what "nobody is editing"
    // looks like. Say which one it is.
    const hostDown = room?.role === "guest" && room.hostReachable === false;
    return (
      <div className={g.empty}>
        <div className={g.emptyIcon}>{hostDown ? "◌" : "◍"}</div>
        {hostDown ? (
          <>
            <p><b>Can&apos;t reach the room host right now.</b></p>
            <p className={g.emptyHint}>
              The board mirrors whoever is hosting the coordinator, so it stays empty until{" "}
              {room?.url ? <code>{room.url}</code> : "the host"} answers again. Locks you take
              meanwhile are kept locally and merge back on reconnect.
            </p>
          </>
        ) : (
          <>
            <p><b>No files are being edited or read right now.</b></p>
            <p className={g.emptyHint}>
              The board fills in the moment an agent reads or edits a file — run <code>relay serve</code> and start a
              task in Claude Code, Cursor, Codex, Copilot or Antigravity.
              {room ? " Everyone in the room sees the same board." : ""}
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={g.wrap}>
      <div className={g.caption}>
        {holder ? <><b>{holder.holder}</b> is editing <b>{holder.path.split("/").pop()}</b> right now. </>
          : reader ? <><b>{reader.reader}</b> is reading <b>{reader.path.split("/").pop()}</b>. </>
          : "Files are open. "}
        {waiting > 0 && <span className={g.warn}><b>{waiting}</b> other agent{waiting > 1 ? "s" : ""} recently edited {waiting > 1 ? "files that are" : "a file that is"} open. </span>}
        {clashes > 0 && <span className={g.bad}><b>{clashes}</b> file{clashes > 1 ? "s need" : " needs"} attention — two people editing at once.</span>}
      </div>

      <div className={g.bar}>
        <div className={g.legend}>
          <span className={g.lg}><svg width="34" height="9"><line x1="0" y1="5" x2="32" y2="5" stroke="var(--holding)" strokeWidth="2.5" strokeDasharray="7 5" /></svg><b>Editing</b></span>
          <span className={g.lg}><svg width="34" height="9"><line x1="0" y1="5" x2="32" y2="5" stroke="var(--idle)" strokeWidth="1.5" strokeDasharray="2 4" /></svg><b>Reading</b></span>
          <span className={g.lg}><svg width="34" height="9"><line x1="0" y1="5" x2="22" y2="5" stroke="var(--waiting)" strokeWidth="1.5" strokeDasharray="4 4" /><circle cx="26" cy="5" r="3" fill="var(--waiting)" /></svg><b>Also working here</b></span>
          <span className={g.lg}><svg width="34" height="9"><line x1="0" y1="5" x2="32" y2="5" stroke="var(--clash)" strokeWidth="2.5" strokeDasharray="7 5" /></svg><b>Clash</b></span>
        </div>
        <div className={g.toggles}>
          <button className={`${g.tog} ${animate ? g.togOn : ""}`} onClick={() => setAnimate((v) => !v)}>
            {animate ? "✓" : "○"} Motion
          </button>
          <button className={`${g.tog} ${showWaiting ? g.togOn : ""}`} onClick={() => setShowWaiting((v) => !v)}>
            {showWaiting ? "✓" : "○"} Recent editors
          </button>
        </div>
      </div>

      <div className={g.canvas}>
        <ReactFlow
          nodes={nodes} edges={edges}
          nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          fitView proOptions={{ hideAttribution: true }}
          minZoom={0.15} maxZoom={1.8}
          nodesDraggable nodesConnectable={false} elementsSelectable
        >
          <Background color="#161616" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable maskColor="rgba(0,0,0,.78)"
            nodeColor={(n) => (n.type === "file" ? "#333" : n.type === "user" ? "#1c1c1c" : "#3a3a3a")} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function LockGraphCanvas() {
  return (
    <ReactFlowProvider>
      <Board />
    </ReactFlowProvider>
  );
}
