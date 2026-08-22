"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRelay } from "@/lib/RelayContext";
import { apiUrl } from "@/lib/api";
import type { Dashboard } from "@/lib/types";
import ui from "@/styles/ui.module.css";

// React Flow touches `window`, so it must not render on the server.
const LockGraphCanvas = dynamic(() => import("./lockgraph/LockGraphCanvas"), {
  ssr: false,
  loading: () => <div className={ui.empty}>Loading board…</div>,
});

function parseAgent(agentId: string) {
  const [label, machine, session] = String(agentId || "").split(":");
  return { label: label || "agent", machine, session };
}

function ttlLeft(lock: { expiresAt?: number }) {
  const ms = (lock.expiresAt || 0) - Date.now();
  if (ms <= 0) return "expiring";
  return `${Math.ceil(ms / 1000)}s`;
}

function GraphView({ graph }: { graph: NonNullable<Dashboard["graph"]> }) {
  const layout = useMemo(() => {
    if (!graph.nodes?.length) return [];
    const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
    return graph.nodes.map((n, i) => ({
      ...n,
      x: 48 + (i % cols) * 170,
      y: 40 + Math.floor(i / cols) * 78,
    }));
  }, [graph]);

  const pos = new Map(layout.map((n) => [n.id, n]));
  const w = Math.max(640, ...layout.map((n) => n.x + 120));
  const h = Math.max(220, ...layout.map((n) => n.y + 48));

  return (
    <article className={ui.card}>
      <h3>Dependency graph</h3>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Live import graph
        {graph.languages?.length ? ` · ${graph.languages.join(", ")}` : ""}. Soft-locks follow dependents
        {graph.lockDepth != null ? ` at depth ${graph.lockDepth}` : ""}.
      </p>
      <p style={{ color: "var(--muted)" }}>
        {graph.fileCount ?? 0} files · {graph.edgeCount ?? 0} edges · {graph.cycles?.length || 0} cycle cluster(s)
        {graph.unresolvable?.length ? ` · ${graph.unresolvable.length} unresolvable` : ""}
      </p>
      {layout.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>
          No source files found in this workspace yet. Open Coordinator after `relay serve` is running so the graph can build.
        </p>
      ) : (
        <div className={ui.graphWrap}>
          <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={Math.min(420, h)}>
            {graph.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={a.locked || b.locked ? "#f5a524" : "#3a3f4a"}
                  strokeWidth={a.locked || b.locked ? 1.6 : 1}
                />
              );
            })}
            {layout.map((n) => (
              <g key={n.id}>
                <circle cx={n.x} cy={n.y} r={n.locked ? 8 : 5} fill={n.locked ? "#f5a524" : n.cyclic ? "#b794f4" : "#3dd68c"} />
                <text x={n.x + 12} y={n.y + 4} fill="#c9cdd6" fontSize="10" fontFamily="IBM Plex Mono, monospace">
                  {n.id.split("/").slice(-2).join("/")}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      {!!graph.nodes?.length && (
        <div style={{ marginTop: 10 }}>
          {graph.nodes.filter((n) => n.locked).map((n) => (
            <div key={n.id} className={ui.lockRow}>
              <code>{n.id}</code>
              <span style={{ color: "var(--amber)" }}>LOCKED</span>
            </div>
          ))}
        </div>
      )}
      {!!graph.cycles?.length && (
        <div style={{ marginTop: 10 }}>
          {graph.cycles.slice(0, 6).map((c, i) => (
            <div key={i} className={ui.lockRow}>
              <code>cycle {c.join(" ↔ ")}</code>
              <span style={{ color: "var(--violet)" }}>unit</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function FileLocksPanel() {
  const { dashboard, selectedProjectId } = useRelay();
  const [view, setView] = useState<"board" | "list">("board");
  const [graph, setGraph] = useState(dashboard?.graph || null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setGraph(dashboard?.graph || null);
  }, [dashboard?.graph]);

  useEffect(() => {
    const id = selectedProjectId || dashboard?.project.id;
    if (!id) return;
    if (dashboard?.graph?.nodes?.length) return;
    fetch(apiUrl(`/api/projects/${id}/graph`))
      .then((r) => (r.ok ? r.json() : null))
      .then((g) => {
        if (g) setGraph(g);
      })
      .catch(() => undefined);
  }, [selectedProjectId, dashboard?.project.id, dashboard?.graph?.nodes?.length]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const connected = dashboard?.agents.filter((a) => a.status === "connected") || [];
  const locks = dashboard?.locks || [];
  const reads = dashboard?.reads || [];
  const fromLocks = [...new Map(locks.map((l) => [l.agentId, l])).values()].map((l) => {
    const parsed = parseAgent(l.agentId);
    return {
      id: l.agentId,
      label: l.holder?.label || parsed.label,
      sessionId: parsed.session,
      ownerLogin: l.holder?.login || parsed.machine,
    };
  });
  const sessions = connected.length ? connected : fromLocks;
  const collisions = dashboard?.stats?.collisions;
  const saved = collisions?.totalSaved ?? 0;
  const roomScope = collisions?.scope === "room";
  const memberLine =
    roomScope && collisions?.byMember?.length
      ? collisions.byMember
          .filter((m) => m.totalSaved > 0)
          .map((m) => `@${m.ownerLogin} ${m.totalSaved}`)
          .join(" · ")
      : "";

  return (
    <>
      <article className={ui.card} style={{ marginBottom: 10 }}>
        <h3>Collisions prevented{roomScope ? " (room)" : ""}</h3>
        <p style={{ fontSize: "1.35rem", margin: "0.2rem 0 0.5rem" }}>
          <strong>{saved}</strong> saved by Relay
        </p>
        {memberLine ? (
          <p style={{ color: "var(--muted)", marginTop: 0, marginBottom: "0.35rem" }}>{memberLine}</p>
        ) : null}
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Blocked claims {collisions?.claimsBlocked ?? 0} · held-back patches{" "}
          {(collisions?.patchesBlocked ?? 0) + (collisions?.patchesSkipped ?? 0)} · merge flags{" "}
          {collisions?.mergesFlagged ?? 0}
          {(collisions?.patchesDeferred ?? 0) > 0 ? ` · deferred ${collisions?.patchesDeferred}` : ""}
        </p>
      </article>

      <div className={ui.rowBetween} style={{ marginBottom: 10 }}>
        <div className={ui.kicker}>Coordinator</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className={`${ui.chip} ${view === "board" ? "" : ui.ghost}`}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            className={`${ui.chip} ${view === "list" ? "" : ui.ghost}`}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
      </div>

      {view === "board" && <LockGraphCanvas />}

      {view === "list" && (
      <>
      <article className={ui.card}>
        <h3>Active agent sessions</h3>
        {sessions.length === 0 && (
          <p style={{ color: "var(--muted)" }}>
            No live claims yet. The next file edit from an agent shows up here immediately.
          </p>
        )}
        {sessions.map((a) => (
          <div className={ui.lockRow} key={a.id}>
            <div>
              {a.label} {a.sessionId ? <span className={ui.badge}>{a.sessionId}</span> : null}
            </div>
            <span style={{ color: "var(--muted)" }}>{a.ownerLogin ? `@${a.ownerLogin}` : "this machine"}</span>
          </div>
        ))}
      </article>
      <article className={ui.card}>
        <h3>Real-time file locks</h3>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Pushed over SSE as hooks claim files. Same agent can keep editing; a different agent is blocked.
        </p>
        {locks.length === 0 && <p style={{ color: "var(--muted)" }}>No active locks.</p>}
        {locks.map((lock) => {
          const parsed = parseAgent(lock.agentId);
          const file = lock.filePath.includes("::") ? lock.filePath.split("::")[1] : lock.filePath;
          const dependents = graph?.nodes.find((n) => n.id === file)?.dependents || [];
          // A released row is history, not a countdown: showing "expires in…"
          // for a lock nobody holds is worse than showing nothing.
          const left = lock.released
            ? `held ${Math.max(1, Math.round((now - (lock.releasedAt || now)) / 1000))}s ago`
            : ttlLeft({ expiresAt: lock.expiresAt || now });
          return (
            // Two agents can legitimately hold one path at once after a tunnel
            // outage, so the file alone is not a unique key.
            <div
              className={ui.lockRow}
              key={`${lock.workspaceId || ""}::${lock.filePath}::${lock.agentId}`}
              style={lock.released ? { opacity: 0.55 } : undefined}
            >
              <div>
                <code>{file}</code>
                <div style={{ color: "var(--muted)", fontSize: 11 }}>
                  {lock.holder?.label || parsed.label} · {parsed.session || "session"} · {lock.source || "coordinator"}
                  {lock.escalated ? " · escalated" : ""}
                  {dependents.length ? ` · soft-locks ${dependents.slice(0, 4).join(", ")}` : ""}
                  {` · ${left}`}
                </div>
              </div>
              <span
                style={{
                  color: lock.released
                    ? "var(--muted)"
                    : lock.mode === "read"
                      ? "var(--blue)"
                      : "var(--amber)",
                }}
              >
                {lock.released ? "DONE" : (lock.mode || "write").toUpperCase()}
              </span>
            </div>
          );
        })}
      </article>
      <article className={ui.card}>
        <h3>Being read</h3>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Files agents are looking at right now. Reads never take a lock and never block an edit.
        </p>
        {reads.length === 0 && <p style={{ color: "var(--muted)" }}>Nobody is reading anything.</p>}
        {reads.map((r) => {
          const parsed = parseAgent(r.agentId);
          return (
            <div className={ui.lockRow} key={`${r.agentId}::${r.filePath}`}>
              <div>
                <code>{r.filePath}</code>
                <div style={{ color: "var(--muted)", fontSize: 11 }}>
                  {r.holder?.label || parsed.label} · {Math.max(1, Math.round((now - r.at) / 1000))}s ago
                </div>
              </div>
              <span style={{ color: "var(--blue)" }}>READ</span>
            </div>
          );
        })}
      </article>
      {graph ? <GraphView graph={graph} /> : (
        <article className={ui.card}>
          <h3>Dependency graph</h3>
          <p style={{ color: "var(--muted)" }}>Building import graph…</p>
        </article>
      )}
      </>
      )}
    </>
  );
}
