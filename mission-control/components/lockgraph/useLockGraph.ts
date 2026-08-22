"use client";

// Builds the User -> Agent -> File model for the Coordinator board.
//
// Everything here is derived from data RelayContext already merges into
// `dashboard`. No new fetch, no new SSE subscription (RelayContext already has
// four writers into `dashboard.locks`; adding a fifth would double-fire), and
// no backend change.
//
// The one non-obvious join: lock.filePath is stored REPO-RELATIVE
// (hooks/relay-hook-lib.js does path.relative(workspace, file)), while the
// machine-specific part lives only in lock.workspaceId. So keying file nodes on
// filePath alone makes two users' locks on the same file converge on ONE node —
// which is how cross-user contention becomes visible even though the backend
// keys them separately.

import { useMemo } from "react";
import type { Collaborator, Dashboard, FileLock, User } from "@/lib/types";

export type EdgeKind = "hold" | "read" | "wait" | "clash";

export type GAgent = {
  id: string;          // `${label}:${host}` — session segment deliberately dropped
  label: string;
  host: string;
  userKey: string;
  state: EdgeKind | "idle";
};

export type GUser = {
  key: string;
  login: string;
  name: string;
  avatarUrl: string | null;
  online: boolean;
  agents: GAgent[];
};

export type GFile = {
  id: string;          // repo-relative path — the shared spine
  path: string;
  holder: string | null;
  reader: string | null;
  ttl: number;         // 0..1 remaining
  secondsLeft: number;
  waiting: number;
  clashUsers: string[];
};

export type GEdge = { id: string; agentId: string; fileId: string; kind: EdgeKind };

export type LockGraph = { users: GUser[]; files: GFile[]; edges: GEdge[]; empty: boolean };

function parseAgentId(agentId: string) {
  const [label, host, session] = String(agentId || "").split(":");
  return { label: label || "agent", host: host || "", session: session || "" };
}

/** Stable per-agent key. The session segment churns on every new run. */
function agentKey(agentId: string) {
  const { label, host } = parseAgentId(agentId);
  return `${label}:${host}`;
}

/**
 * Attribute a lock to a person.
 *
 * Locks identify a MACHINE, not a GitHub account: the hook sends
 * `holder: { label, host }` even though the type declares `login`. So:
 *   1. use holder.login when it is ever populated (future-proof),
 *   2. otherwise, if every lock came from one host, it is this user,
 *   3. otherwise fall back to grouping by hostname.
 */
function makeResolveUser(
  locks: { agentId: string; holder?: FileLock["holder"] }[],
  me: User | null,
  collaborators: Collaborator[],
  shared: boolean
) {
  const hosts = new Set(locks.map((l) => parseAgentId(l.agentId).host).filter(Boolean));
  // In a room the single host may well be someone else's machine, so claiming
  // it for the viewer would label the host's work with the guest's name.
  const singleHost = hosts.size <= 1 && !shared;

  return (agentId: string, holder?: FileLock["holder"]): { key: string; login: string; name: string; avatarUrl: string | null } => {
    const login = (holder as { login?: string } | null | undefined)?.login;
    if (login) {
      // Logins reach us from three places (hook, room roster, GitHub) and only
      // agree case-insensitively.
      const c = collaborators.find((x) => String(x.login).toLowerCase() === String(login).toLowerCase());
      return { key: login.toLowerCase(), login, name: c?.name || login, avatarUrl: c?.avatarUrl || null };
    }
    const { host } = parseAgentId(agentId);
    if (singleHost && me) {
      return { key: me.login, login: me.login, name: me.name || me.login, avatarUrl: me.avatarUrl || null };
    }
    const label = host || "this machine";
    return { key: `host:${label}`, login: label, name: label, avatarUrl: null };
  };
}

export function useLockGraph(dashboard: Dashboard | null, me: User | null, now: number): LockGraph {
  return useMemo(() => {
    // Include released rows: a pre-tool claim and post-tool release can be
    // ~100ms apart, faster than the board can paint a "held right now" lock.
    // Activity keeps the edit because it is a log; the board used to drop the
    // afterglow and look empty while the feed was full. 45s matches the
    // coordinator's RECENT_TTL_MS.
    const GLOW_MS = 45_000;
    const locks = dashboard?.locks ?? [];
    const liveReads = dashboard?.reads ?? [];
    const collaborators = dashboard?.collaborators ?? [];
    const conflicts = dashboard?.conflicts ?? [];
    const known = dashboard?.agents ?? [];
    const resolveUser = makeResolveUser(
      [...locks, ...liveReads.map((r) => ({ agentId: r.agentId, holder: r.holder }))],
      me,
      collaborators,
      Boolean(dashboard?.room?.url)
    );

    const users = new Map<string, GUser>();
    const agents = new Map<string, GAgent>();
    const files = new Map<string, GFile>();
    const edges: GEdge[] = [];

    const ensureUser = (u: ReturnType<typeof resolveUser>) => {
      if (!users.has(u.key)) {
        const c = collaborators.find((x) => String(x.login).toLowerCase() === String(u.login).toLowerCase());
        users.set(u.key, {
          key: u.key, login: u.login, name: u.name, avatarUrl: u.avatarUrl,
          online: c?.online ?? true, agents: [],
        });
      }
      return users.get(u.key)!;
    };

    const ensureAgent = (agentId: string, holder: FileLock["holder"] | undefined) => {
      const key = agentKey(agentId);
      if (!agents.has(key)) {
        const { label, host } = parseAgentId(agentId);
        const u = ensureUser(resolveUser(agentId, holder));
        const a: GAgent = { id: key, label: holder?.label || label, host, userKey: u.key, state: "idle" };
        agents.set(key, a);
        u.agents.push(a);
      }
      return agents.get(key)!;
    };

    // --- files + hold edges from WRITE locks only. Reads are presence, not
    // claims, and live in dashboard.reads so they cannot be mistaken for a lock.
    for (const lock of locks) {
      if (lock.mode === "read") continue;
      const fileId = lock.filePath.includes("::") ? lock.filePath.split("::")[1] : lock.filePath;
      const left = lock.released
        ? Math.max(0, (lock.releasedAt || 0) + GLOW_MS - now)
        : Math.max(0, (lock.expiresAt || 0) - now);
      if (lock.released && left <= 0) continue;
      if (!files.has(fileId)) {
        files.set(fileId, {
          id: fileId, path: fileId, holder: null, reader: null,
          ttl: 0, secondsLeft: 0, waiting: 0, clashUsers: [],
        });
      }
      const f = files.get(fileId)!;
      const agent = ensureAgent(lock.agentId, lock.holder);

      const ttlMs = lock.released ? GLOW_MS : (lock.ttlMs || GLOW_MS);
      const frac = ttlMs ? Math.max(0, Math.min(1, left / ttlMs)) : 0;
      f.holder = agent.label;
      f.ttl = frac;
      f.secondsLeft = Math.ceil(left / 1000);
      agent.state = "hold";
      edges.push({ id: `l-${agent.id}-${fileId}`, agentId: agent.id, fileId, kind: "hold" });
    }

    // --- read presence: visualization only, never a lock ---
    for (const row of liveReads) {
      const fileId = row.filePath.includes("::") ? row.filePath.split("::")[1] : row.filePath;
      if (!fileId) continue;
      if (!files.has(fileId)) {
        files.set(fileId, {
          id: fileId, path: fileId, holder: null, reader: null,
          ttl: 0, secondsLeft: 0, waiting: 0, clashUsers: [],
        });
      }
      const f = files.get(fileId)!;
      const agent = ensureAgent(row.agentId, row.holder);
      const exp = row.expiresAt || (row.at || 0) + 30_000;
      const ttlMs = row.ttlMs || 30_000;
      const left = Math.max(0, exp - now);
      const frac = Math.max(0, Math.min(1, left / ttlMs));
      if (!f.holder) {
        f.reader = agent.label;
        f.ttl = frac;
        f.secondsLeft = Math.ceil(left / 1000);
      }
      if (agent.state === "idle") agent.state = "read";
      if (edges.some((e) => e.agentId === agent.id && e.fileId === fileId && e.kind === "hold")) continue;
      edges.push({ id: `r-${agent.id}-${fileId}`, agentId: agent.id, fileId, kind: "read" });
    }

    // Same stream that fills Activity: a code edit in the transcript is the
    // board lighting up even when the pre-tool hook never claimed (or claimed
    // and released before the first paint).
    for (const edit of dashboard?.edits ?? []) {
      const fileId = String(edit.file || "").replace(/\\/g, "/");
      if (!fileId || now - (edit.ts || 0) > GLOW_MS) continue;
      if (files.has(fileId)) continue;
      files.set(fileId, {
        id: fileId, path: fileId, holder: null, reader: null,
        ttl: 0, secondsLeft: 0, waiting: 0, clashUsers: [],
      });
      const f = files.get(fileId)!;
      const agentId = `${edit.agent}:${edit.ownerLogin || "local"}`;
      const agent = ensureAgent(agentId, { label: edit.agent, login: edit.ownerLogin });
      const left = Math.max(0, GLOW_MS - (now - edit.ts));
      f.holder = agent.label;
      f.ttl = left / GLOW_MS;
      f.secondsLeft = Math.ceil(left / 1000);
      agent.state = "hold";
      edges.push({ id: `e-${agent.id}-${fileId}`, agentId: agent.id, fileId, kind: "hold" });
    }

    // --- clash: one file, two distinct people ---
    for (const f of files.values()) {
      const owners = new Set(
        edges.filter((e) => e.fileId === f.id && (e.kind === "hold" || e.kind === "clash"))
          .map((e) => agents.get(e.agentId)?.userKey)
          .filter(Boolean) as string[]
      );
      if (owners.size > 1) {
        f.clashUsers = [...owners].map((k) => users.get(k)?.login || k);
        edges.forEach((e) => { if (e.fileId === f.id && e.kind === "hold") e.kind = "clash"; });
      }
    }

    // --- "also working here": recently edited by an agent that does NOT hold it.
    // This is dashboard.conflicts (files edited by 2+ agents in the last 5 min).
    // It is NOT a real wait-queue — a denied claim mutates no state and emits no
    // event, so a true queue is not observable from the frontend at any price.
    const holdersOf = new Map<string, Set<string>>();
    edges.forEach((e) => {
      if (!holdersOf.has(e.fileId)) holdersOf.set(e.fileId, new Set());
      holdersOf.get(e.fileId)!.add(e.agentId);
    });
    for (const c of conflicts) {
      const f = files.get(c.file);
      if (!f) continue;                       // only annotate files that are live
      for (const label of c.agents) {
        const match = [...agents.values()].find((a) => a.label.toLowerCase() === String(label).toLowerCase());
        if (!match || holdersOf.get(c.file)?.has(match.id)) continue;
        if (match.state === "idle") match.state = "wait";
        f.waiting += 1;
        edges.push({ id: `w-${match.id}-${c.file}`, agentId: match.id, fileId: c.file, kind: "wait" });
      }
    }

    // --- registered-but-idle agents, so the board shows the whole team ---
    for (const a of known) {
      if (a.status !== "connected") continue;
      const label = String(a.label || "");
      // match on label, not on a synthesised key — an agent that holds a lock is
      // keyed "claude:HOST" and must not be duplicated as a second idle node
      const already = [...agents.values()].some(
        (x) => x.label.toLowerCase() === label.toLowerCase()
      );
      if (already) continue;
      const u = ensureUser(resolveUser(label, null));
      const node: GAgent = { id: `idle:${label}`, label, host: "", userKey: u.key, state: "idle" };
      agents.set(node.id, node);
      u.agents.push(node);
    }

    const userList = [...users.values()].sort((a, b) => a.login.localeCompare(b.login));
    const fileList = [...files.values()].sort((a, b) => {
      if (!!b.clashUsers.length !== !!a.clashUsers.length) return b.clashUsers.length - a.clashUsers.length;
      return a.path.localeCompare(b.path);
    });

    return { users: userList, files: fileList, edges, empty: fileList.length === 0 && userList.length === 0 };
    // `now` is intentionally a dependency: it drives the TTL rings.
  }, [dashboard, me, now]);
}
