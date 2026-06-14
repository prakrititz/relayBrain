'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AGENTS,
  AgentId,
  RelayDashboard,
  RelayDashboardIr,
  RelayMemory,
  RelayProject,
  connectAgent as apiConnect,
  getMemory,
  getProject,
  getProjectDashboard,
  listProjects,
  pingRelay,
  registerWorkspace,
  sendHandshake,
  syncProject,
  syncWorkspace,
} from './relay';
import {
  Workspace,
  WORKSPACES_CHANGED_EVENT,
  badgeFromName,
  getActiveWorkspace,
  loadWorkspaces,
  saveWorkspaces,
} from './workspaces';

export type AgentStatus = 'idle' | 'handshaking' | 'connected' | 'error';

export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  eventCount: number;
  error?: string;
}

interface RelayContextValue {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  activeProject: RelayProject | null;
  relayOnline: boolean;
  memory: RelayMemory | null;
  dashboard: RelayDashboard | null;
  agentStates: AgentState[];
  syncing: boolean;
  addWorkspace: (ws: Omit<Workspace, 'active'>) => void;
  selectWorkspace: (id: string) => void;
  removeWorkspace: (id: string) => void;
  registerAndAdd: (ws: Omit<Workspace, 'active'>) => Promise<void>;
  connect: (agent: AgentId) => Promise<void>;
  refresh: (opts?: { full?: boolean }) => Promise<void>;
}

const RelayContext = createContext<RelayContextValue | null>(null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryFingerprint(mem: RelayMemory | null): string {
  if (!mem) return '';
  return `${mem.lastSync || ''}:${mem.timeline?.length || 0}`;
}

function dashboardFingerprint(d: RelayDashboard | null): string {
  if (!d) return '';
  const ir = d.ir || ({} as RelayDashboardIr);
  return [
    d.lastSync || '',
    d.handoff?.markdown?.length || 0,
    ir.currentTask?.length || 0,
    ir.decisions?.length || 0,
    ir.failures?.length || 0,
    ir.project?.length || 0,
  ].join(':');
}

export function RelayProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [relayOnline, setRelayOnline] = useState(false);
  const [memory, setMemory] = useState<RelayMemory | null>(null);
  const [dashboard, setDashboard] = useState<RelayDashboard | null>(null);
  const [activeProject, setActiveProject] = useState<RelayProject | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<
    Partial<Record<AgentId, { status: 'handshaking' | 'error'; error?: string }>>
  >({});

  const activeWorkspace = useMemo(() => getActiveWorkspace(workspaces), [workspaces]);
  const activePath = activeWorkspace?.localPath || null;
  const projectId = activeWorkspace?.relayProjectId || activeProject?.id || null;

  const lastMemFp = useRef('');
  const lastDashFp = useRef('');

  useEffect(() => {
    const loaded = loadWorkspaces();
    setWorkspaces(loaded);
    saveWorkspaces(loaded);
    const reload = () => setWorkspaces(loadWorkspaces());
    window.addEventListener('storage', reload);
    window.addEventListener(WORKSPACES_CHANGED_EVENT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(WORKSPACES_CHANGED_EVENT, reload);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const ok = await pingRelay();
      if (alive) setRelayOnline(ok);
    };
    check();
    const t = setInterval(check, 10000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const resolveProject = useCallback(async (path: string) => {
    try {
      const { projects } = await listProjects();
      return projects.find((p) => p.workspacePath === path) || null;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(
    async (opts: { full?: boolean } = {}) => {
      if (!activePath) return;
      setSyncing(true);
      try {
        let project = activeProject;
        if (!project) {
          project = await resolveProject(activePath);
          if (project) setActiveProject(project);
        }

        if (opts.full) {
          if (project?.id) await syncProject(project.id);
          else await syncWorkspace(activePath);
        }

        if (project?.id) {
          const { dashboard: d } = await getProjectDashboard(project.id, { limit: 200 });
          const { project: fullProject } = await getProject(project.id);
          setActiveProject(fullProject);
          const fp = dashboardFingerprint(d);
          if (fp !== lastDashFp.current) {
            lastDashFp.current = fp;
            setDashboard(d);
          }
        }

        const mem = await getMemory(activePath);
        const memFp = memoryFingerprint(mem);
        if (memFp !== lastMemFp.current) {
          lastMemFp.current = memFp;
          setMemory(mem);
        }
      } catch {
        /* keep last state — no flash to empty */
      } finally {
        setSyncing(false);
      }
    },
    [activePath, activeProject, resolveProject],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    setPending({});
    if (!activePath) {
      setMemory(null);
      setDashboard(null);
      setActiveProject(null);
      lastMemFp.current = '';
      lastDashFp.current = '';
      return;
    }

    let cancelled = false;
    (async () => {
      const project = await resolveProject(activePath);
      if (cancelled) return;
      if (project) setActiveProject(project);
      lastMemFp.current = '';
      lastDashFp.current = '';
      await refreshRef.current({ full: true });
    })();

    const t = setInterval(() => refreshRef.current({ full: false }), 12000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [activePath, resolveProject]);

  const addWorkspace = useCallback((ws: Omit<Workspace, 'active'>) => {
    setWorkspaces((prev) => {
      const others = prev.filter((w) => w.id !== ws.id).map((w) => ({ ...w, active: false }));
      const next = [...others, { ...ws, active: true }];
      saveWorkspaces(next);
      return next;
    });
  }, []);

  const registerAndAdd = useCallback(
    async (ws: Omit<Workspace, 'active'>) => {
      const { project } = await registerWorkspace(ws.localPath, ws.full);
      addWorkspace({
        ...ws,
        relayProjectId: project.id,
        name: badgeFromName(project.name || ws.full),
        full: project.name || ws.full,
      });
    },
    [addWorkspace],
  );

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => {
      const next = prev.map((w) => ({ ...w, active: w.id === id }));
      saveWorkspaces(next);
      return next;
    });
  }, []);

  const removeWorkspace = useCallback((id: string) => {
    setWorkspaces((prev) => {
      const remaining = prev.filter((w) => w.id !== id);
      if (remaining.length && !remaining.some((w) => w.active)) remaining[0].active = true;
      saveWorkspaces(remaining);
      return remaining;
    });
  }, []);

  const connect = useCallback(
    async (agent: AgentId) => {
      if (!activePath) throw new Error('Select a workspace first.');
      setPending((p) => ({ ...p, [agent]: { status: 'handshaking' } }));
      try {
        await sendHandshake(activePath, agent, projectId || undefined);
        await sleep(2000);
        await apiConnect(activePath, agent, projectId || undefined);
        setPending((p) => {
          const next = { ...p };
          delete next[agent];
          return next;
        });
        await refresh({ full: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Connection failed';
        setPending((p) => ({ ...p, [agent]: { status: 'error', error: message } }));
        throw err;
      }
    },
    [activePath, projectId, refresh],
  );

  const agentStates = useMemo<AgentState[]>(() => {
    return AGENTS.map(({ id }) => {
      const p = pending[id];
      const mem = memory?.agents?.[id];
      const dashAgent = dashboard?.agents?.find((a) => a.name === id);
      const eventCount = mem?.eventCount ?? dashAgent?.eventCount ?? 0;
      if (p) return { id, status: p.status, eventCount, error: p.error };
      if (mem?.status === 'connected' || dashAgent?.status === 'connected') {
        return { id, status: 'connected', eventCount };
      }
      return { id, status: 'idle', eventCount: 0 };
    });
  }, [pending, memory, dashboard]);

  const value: RelayContextValue = {
    workspaces,
    activeWorkspace,
    activeProject,
    relayOnline,
    memory,
    dashboard,
    agentStates,
    syncing,
    addWorkspace,
    selectWorkspace,
    removeWorkspace,
    registerAndAdd,
    connect,
    refresh,
  };

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
}

export function useRelay(): RelayContextValue {
  const ctx = useContext(RelayContext);
  if (!ctx) throw new Error('useRelay must be used within <RelayProvider>');
  return ctx;
}
