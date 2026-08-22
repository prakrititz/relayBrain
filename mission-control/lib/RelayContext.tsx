"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Agent, CodeEdit, Dashboard, Notice, Project, TabId, User } from "./types";
import { apiUrl } from "./api";

type RelayState = {
  user: User | null;
  users: User[];
  projects: Project[];
  dashboard: Dashboard | null;
  selectedProjectId: string | null;
  tab: TabId;
  addOpen: boolean;
  loading: boolean;
  syncing: boolean;
  lastFetchedAt: number | null;
  setTab: (tab: TabId) => void;
  setAddOpen: (open: boolean) => void;
  login: (loginName: string) => Promise<void>;
  logout: () => Promise<void>;
  selectProject: (id: string) => Promise<void>;
  sync: () => Promise<void>;
  rewind: (lamport: number) => Promise<void>;
  handshake: (agent: Agent) => Promise<void>;
  connectAgent: (agent: Agent) => Promise<void>;
  addProject: (body: { name?: string; path?: string; remoteUrl?: string; mode: "clone" | "local" }) => Promise<void>;
  leaveWorkspace: (id: string) => Promise<{ ok: boolean; hint?: string }>;
  removeWorkspace: (id: string) => Promise<{ ok: boolean; hint?: string }>;
  notices: Notice[];
  toasts: Notice[];
  unreadNotices: number;
  markNoticeRead: (id: string) => Promise<void>;
  markAllNoticesRead: () => Promise<void>;
  dismissNotice: (idOrKey: { id?: string; key?: string }) => Promise<void>;
  dismissToast: (id: string) => void;
  joinRoom: (payload: {
    url?: string;
    hostLogin?: string;
    roomId?: string;
    gistId?: string;
    seed?: boolean;
  }) => Promise<{ ok: boolean; hint?: string }>;
};

const Ctx = createContext<RelayState | null>(null);

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export function RelayProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("activity");
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [toasts, setToasts] = useState<Notice[]>([]);
  const selectedRef = useRef<string | null>(null);
  const fetchGen = useRef(0);
  const dashCache = useRef(new Map<string, Dashboard>());
  const fetchedAt = useRef(new Map<string, number>());
  const noticesReady = useRef(false);
  // When each streamed field was last updated by the live socket. A full
  // dashboard fetch is a snapshot of the moment it *started*, so if it lands
  // after a stream has already moved one of these fields on, it is stale for
  // that field and must not be allowed to write over it.
  const liveAt = useRef<Partial<Record<keyof Dashboard, number>>>({});
  const refreshTimer = useRef<number | null>(null);

  const markLive = (...fields: (keyof Dashboard)[]) => {
    const now = Date.now();
    for (const f of fields) liveAt.current[f] = now;
  };

  const applySelection = (id: string) => {
    selectedRef.current = id;
    setSelectedProjectId(id);
    liveAt.current = {};
    const cached = dashCache.current.get(id);
    if (cached) {
      setDashboard(cached);
      setLastFetchedAt(fetchedAt.current.get(id) ?? null);
    }
  };

  // Fields the live streams own. A snapshot may only fill these in when it has
  // nothing fresher to overwrite.
  const STREAMED: (keyof Dashboard)[] = ["locks", "reads", "patches", "edits", "activity", "agents", "graph"];

  const staleIncoming = (field: keyof Dashboard, incoming: unknown) => {
    if (incoming == null) return true;
    if (Array.isArray(incoming)) return incoming.length === 0;
    if (field === "graph" && typeof incoming === "object") {
      const nodes = (incoming as { nodes?: unknown[] }).nodes;
      return !Array.isArray(nodes) || nodes.length === 0;
    }
    return false;
  };

  const fetchDash = useCallback(async (id: string, busy = false) => {
    const gen = ++fetchGen.current;
    if (busy) setSyncing(true);
    try {
      const dash = await json<Dashboard>(`/api/projects/${id}/dashboard`);
      dashCache.current.set(dash.project.id, dash);
      const at = Date.now();
      fetchedAt.current.set(dash.project.id, at);
      if (selectedRef.current && dash.project.id !== selectedRef.current) return dash;
      // A slower earlier request must not land on top of a newer one and walk
      // the view backwards.
      if (gen !== fetchGen.current) return dash;
      setDashboard((prev) => {
        if (!prev || prev.project.id !== dash.project.id) return dash;
        const merged = { ...dash };
        // Streams own these fields. A dashboard snapshot is whatever was true
        // when the request *started*, often after a slow GitHub/ngrok round
        // trip, and it used to paint the Coordinator blank the moment Sync
        // (or a tunnel hiccup) returned empty locks. Once a stream has written
        // a field, the poll may never take it back.
        for (const field of STREAMED) {
          const previous = prev[field];
          if (previous === undefined) continue;
          if (liveAt.current[field]) {
            (merged as Record<string, unknown>)[field] = previous;
            continue;
          }
          if (staleIncoming(field, merged[field]) && !staleIncoming(field, previous)) {
            (merged as Record<string, unknown>)[field] = previous;
          }
        }
        return merged;
      });
      setLastFetchedAt(at);
      return dash;
    } finally {
      if (busy && gen === fetchGen.current) setSyncing(false);
    }
  }, []);

  const loadAll = useCallback(async (id?: string) => {
    const [session, proj] = await Promise.all([
      json<{ user: User; users: User[]; projectId: string }>("/api/session"),
      json<{ projects: Project[] }>("/api/projects"),
    ]);
    setUser(session.user);
    setUsers(session.users);
    setProjects(proj.projects);
    const alreadyPicked = selectedRef.current;
    const selected = id || alreadyPicked || session.projectId || proj.projects[0]?.id;
    if (selected && !alreadyPicked) applySelection(selected);
    const target = selectedRef.current || selected;
    if (target) await fetchDash(target);
    try {
      const body = await json<{ notices: Notice[] }>("/api/notices");
      setNotices(body.notices || []);
    } catch {
      /* bell stays empty until SSE */
    }
    noticesReady.current = true;
    setLoading(false);
  }, [fetchDash]);

  useEffect(() => {
    loadAll().catch(() => setLoading(false));
  }, [loadAll]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const ev = new EventSource(apiUrl(`/api/events?projectId=${selectedProjectId}`));
    // Several event types each used to trigger their own full dashboard fetch,
    // so one busy second of agent activity queued a pile of overlapping
    // multi-hundred-KB requests that then landed out of order. One trailing
    // fetch per burst is enough — the streams already carry the detail.
    const refresh = () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        if (selectedRef.current) fetchDash(selectedRef.current).catch(() => undefined);
      }, 400);
    };
    const applyHistory = (data: Record<string, unknown>) => {
      if (data.workspaceId && data.workspaceId !== selectedRef.current) return;
      if (!Array.isArray(data.chats) && !Array.isArray(data.activity)) {
        // Transcript harvest finished with no payload. Streams already carry
        // locks/reads; a full dashboard GET here is what blanked the board.
        return;
      }
      markLive("chats", "timeline", "activity", "edits", "agents");
      setDashboard((d) => {
        if (!d || d.project.id !== selectedRef.current) return d;
        return {
          ...d,
          chats: (data.chats as Dashboard["chats"]) || d.chats,
          timeline: (data.timeline as Dashboard["timeline"]) || d.timeline,
          activity: (data.activity as Dashboard["activity"]) || d.activity,
          edits: (data.edits as Dashboard["edits"]) || d.edits,
          agents: (data.agents as Dashboard["agents"]) || d.agents,
        };
      });
      setLastFetchedAt(Date.now());
    };
    ev.addEventListener("locks", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.workspaceId && data.workspaceId !== selectedRef.current) return;
      if (!Array.isArray(data.locks) && !Array.isArray(data.reads)) return;
      markLive("locks", "reads");
      setDashboard((d) => {
        if (!d || d.project.id !== selectedRef.current) return d;
        return {
          ...d,
          locks: Array.isArray(data.locks) ? data.locks : d.locks,
          reads: Array.isArray(data.reads) ? data.reads : d.reads,
        };
      });
    });
    ev.addEventListener("graph", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (!data.graph) return;
      markLive("graph");
      setDashboard((d) => (d && d.project.id === selectedRef.current ? { ...d, graph: data.graph } : d));
    });
    ev.addEventListener("history", (e) => applyHistory(JSON.parse((e as MessageEvent).data)));
    ev.addEventListener("patch", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.workspaceId && data.workspaceId !== selectedRef.current) return;
      if (!data.patch || !data.edit) {
        refresh();
        return;
      }
      markLive("patches", "edits");
      setDashboard((d) => {
        if (!d || d.project.id !== selectedRef.current) return d;
        // The row, not the patch: a patch carries the whole file body, and
        // keeping 80 of those alive in the tab is how the UI starts to crawl.
        const edit = data.edit as CodeEdit;
        const prepend = (rows?: CodeEdit[]) => [edit, ...(rows || []).filter((r) => r.id !== edit.id)].slice(0, 80);
        return { ...d, patches: prepend(d.patches), edits: prepend(d.edits) };
      });
      setLastFetchedAt(Date.now());
    });
    ev.addEventListener("rewind", refresh);
    ev.addEventListener("central", refresh);
    ev.addEventListener("presence", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (!data.tunnel && !data.reconnect) return;
      // Tunnel URL changed — patch the room row. A full dashboard fetch is
      // what made Coordinator go blank every time ngrok republished.
      setDashboard((d) => {
        if (!d || (data.workspaceId && d.project.id !== data.workspaceId)) return d;
        if (!d.room) return d;
        return { ...d, room: { ...d.room, url: data.tunnel || d.room.url } };
      });
    });
    ev.addEventListener("notice", (e) => {
      const notice = JSON.parse((e as MessageEvent).data) as Notice;
      if (!notice?.id) return;
      setNotices((list) => [notice, ...list.filter((n) => n.id !== notice.id && n.key !== notice.key)]);
      if (noticesReady.current) {
        setToasts((list) => [notice, ...list.filter((n) => n.id !== notice.id)].slice(0, 4));
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification(notice.title, { body: notice.body || "", silent: false });
          } catch {
            /* browser blocked it */
          }
        }
      }
    });
    ev.addEventListener("agents", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (!data.agents) return;
      markLive("agents");
      setDashboard((d) => (d && d.project.id === selectedRef.current ? { ...d, agents: data.agents } : d));
    });
    ev.addEventListener("activity", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (!data.item) return;
      markLive("activity");
      setDashboard((d) =>
        d && d.project.id === selectedRef.current
          ? { ...d, activity: [data.item, ...d.activity].slice(0, 40) }
          : d
      );
    });
    ev.addEventListener("projects", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      if (data.projects) setProjects(data.projects);
    });
    return () => ev.close();
  }, [selectedProjectId, fetchDash]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const tick = () => {
      if (selectedRef.current) fetchDash(selectedRef.current).catch(() => undefined);
    };
    const id = window.setInterval(tick, 45000);
    return () => window.clearInterval(id);
  }, [selectedProjectId, fetchDash]);

  useEffect(() => {
    if (!selectedProjectId) return;
    const ev = new EventSource(apiUrl(`/api/locks/stream?projectId=${selectedProjectId}`));
    ev.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (!Array.isArray(data.locks) && !Array.isArray(data.reads)) return;
      markLive("locks", "reads");
      setDashboard((d) => {
        if (!d || d.project.id !== selectedRef.current) return d;
        return {
          ...d,
          locks: Array.isArray(data.locks) ? data.locks : d.locks,
          reads: Array.isArray(data.reads) ? data.reads : d.reads,
        };
      });
    };
    return () => ev.close();
  }, [selectedProjectId]);

  const login = async (loginName: string) => {
    const { user: next } = await json<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login: loginName }),
    });
    setUser(next);
    if (selectedRef.current) await fetchDash(selectedRef.current);
  };

  const logout = async () => {
    await json("/api/auth/logout", { method: "POST" });
    setUser(null);
  };

  const selectProject = async (id: string) => {
    if (id === selectedRef.current) return;
    applySelection(id);
    json(`/api/projects/${id}/select`, { method: "POST" }).catch(() => undefined);
    await fetchDash(id);
  };

  const sync = async () => {
    const id = selectedRef.current;
    if (!id) return;
    setSyncing(true);
    try {
      await json(`/api/projects/${id}/sync`, { method: "POST" });
      await fetchDash(id);
    } finally {
      if (selectedRef.current === id) setSyncing(false);
    }
  };

  const rewind = async (lamport: number) => {
    const id = selectedRef.current;
    if (!id) return;
    await json(`/api/projects/${id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ lamport }),
    });
    await fetchDash(id, true);
  };

  const handshake = async (agent: Agent) => {
    const id = selectedRef.current;
    if (!id) return;
    await json("/api/handshake", {
      method: "POST",
      body: JSON.stringify({ projectId: id, agent: agent.label }),
    });
    setTimeout(() => connectAgent(agent), 700);
  };

  const connectAgent = async (agent: Agent) => {
    const id = selectedRef.current;
    if (!id) return;
    const { agent: row } = await json<{ agent: Agent }>("/api/connect", {
      method: "POST",
      body: JSON.stringify({ projectId: id, agent: agent.label }),
    });
    setDashboard((d) =>
      d && d.project.id === id
        ? {
            ...d,
            agents: d.agents.map((a) =>
              a.id === row.id || (a.label === row.label && (a.ownerLogin || "") === (row.ownerLogin || ""))
                ? row
                : a
            ),
          }
        : d
    );
  };

  const addProject = async (body: { name?: string; path?: string; remoteUrl?: string; mode: "clone" | "local" }) => {
    const { project } = await json<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setProjects((p) => [...p, project]);
    setAddOpen(false);
    await selectProject(project.id);
  };

  const dropWorkspace = async (id: string, mode: "leave" | "remove"): Promise<{ ok: boolean; hint?: string }> => {
    const verb = mode === "remove" ? "remove" : "leave";
    const fail = (hint: string) => {
      const notice: Notice = {
        id: `drop-${Date.now()}`,
        type: "left",
        key: `drop:${id}`,
        title: mode === "remove" ? "Could not remove workspace" : "Could not leave workspace",
        body: hint,
        ts: Date.now(),
      };
      setToasts((list) => [notice, ...list.filter((t) => t.key !== notice.key)].slice(0, 4));
      return { ok: false as const, hint };
    };
    let res: Response;
    try {
      res = await fetch(apiUrl(`/api/projects/${id}?mode=${mode}`), { method: "DELETE" });
    } catch {
      return fail(`Could not ${verb} workspace. Check that Relay is running.`);
    }
    let body: { ok?: boolean; nextId?: string | null; error?: string; hint?: string } = {};
    try {
      body = (await res.json()) || {};
    } catch {
      return fail(`Could not ${verb} workspace (${res.status}). Files were not changed.`);
    }
    if (!res.ok || body.ok === false) {
      return fail(body.hint || body.error || `Could not ${verb} workspace (${res.status}).`);
    }
    try {
      setProjects((list) => list.filter((p) => p.id !== id));
      dashCache.current.delete(id);
      if (selectedRef.current === id) {
        const next = body.nextId || null;
        if (next) await selectProject(next);
        else {
          selectedRef.current = null;
          setSelectedProjectId(null);
          setDashboard(null);
        }
      }
    } catch {
      /* already unregistered; selection can catch up on the next load */
    }
    return { ok: true };
  };
  const leaveWorkspace = (id: string) => dropWorkspace(id, "leave");
  const removeWorkspace = (id: string) => dropWorkspace(id, "remove");

  const applyNoticeList = (rows: Notice[]) => {
    setNotices(rows);
    const live = new Set(rows.map((n) => n.id));
    setToasts((list) => list.filter((t) => live.has(t.id)));
  };

  const markNoticeRead = async (id: string) => {
    try {
      const body = await json<{ notices: Notice[] }>(`/api/notices/${id}/read`, { method: "POST" });
      applyNoticeList(body.notices || []);
    } catch {
      setNotices((list) => list.map((n) => (n.id === id ? { ...n, readAt: Date.now() } : n)));
    }
  };

  const markAllNoticesRead = async () => {
    try {
      const body = await json<{ notices: Notice[] }>("/api/notices/read-all", { method: "POST" });
      applyNoticeList(body.notices || []);
    } catch {
      setNotices((list) => list.map((n) => ({ ...n, readAt: n.readAt || Date.now() })));
    }
  };

  const dismissNotice = async (idOrKey: { id?: string; key?: string }) => {
    try {
      const body = await json<{ notices: Notice[] }>("/api/notices/dismiss", {
        method: "POST",
        body: JSON.stringify(idOrKey),
      });
      applyNoticeList(body.notices || []);
    } catch {
      setNotices((list) => list.filter((n) => n.id !== idOrKey.id && (!idOrKey.key || n.key !== idOrKey.key)));
      setToasts((list) => list.filter((n) => n.id !== idOrKey.id && (!idOrKey.key || n.key !== idOrKey.key)));
    }
  };

  const dismissToast = (id: string) => {
    setToasts((list) => list.filter((n) => n.id !== id));
  };

  const joinRoom = async (payload: {
    url?: string;
    hostLogin?: string;
    roomId?: string;
    gistId?: string;
    seed?: boolean;
  }) => {
    const res = await fetch(apiUrl("/api/room/join"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, seed: payload.seed !== false }),
    });
    const body = await res.json();
    if (!body.ok) return { ok: false, hint: body.detail || body.hint || body.error || "Could not join" };
    if (payload.roomId) await dismissNotice({ key: `invite:${payload.roomId}` });
    if (selectedRef.current) await fetchDash(selectedRef.current);
    setTab("team");
    return {
      ok: true,
      hint: body.seeded?.error ? `Joined, but the workspace copy failed: ${body.seeded.error}` : "Joined.",
    };
  };

  const unreadNotices = notices.filter((n) => !n.readAt).length;

  const value = useMemo(
    () => ({
      user,
      users,
      projects,
      dashboard,
      selectedProjectId,
      tab,
      addOpen,
      loading,
      syncing,
      lastFetchedAt,
      setTab,
      setAddOpen,
      login,
      logout,
      selectProject,
      sync,
      rewind,
      handshake,
      connectAgent,
      addProject,
      leaveWorkspace,
      removeWorkspace,
      notices,
      toasts,
      unreadNotices,
      markNoticeRead,
      markAllNoticesRead,
      dismissNotice,
      dismissToast,
      joinRoom,
    }),
    [user, users, projects, dashboard, selectedProjectId, tab, addOpen, loading, syncing, lastFetchedAt, notices, toasts, unreadNotices]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRelay() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRelay outside provider");
  return ctx;
}
