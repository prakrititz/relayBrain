// Typed client for the Relay companion backend (backend/server.js).

export const RELAY_URL =
  process.env.NEXT_PUBLIC_RELAY_URL || 'http://localhost:3001';

export type AgentId =
  | 'Antigravity'
  | 'Codex'
  | 'Claude Code'
  | 'GitHub Copilot'
  | 'Cursor';

export interface AgentMeta {
  id: AgentId;
  label: string;
  logo: string;
  desc: string;
  accent: string;
}

export const AGENTS: AgentMeta[] = [
  { id: 'Claude Code', label: 'Claude', logo: '/logos/Claude.png', desc: 'Anthropic Claude Code CLI', accent: '#fcd34d' },
  { id: 'Codex', label: 'Codex', logo: '/logos/Codex.png', desc: 'OpenAI Codex CLI', accent: '#6ee7b7' },
  { id: 'GitHub Copilot', label: 'Copilot', logo: '/logos/github-copilot.png', desc: 'GitHub Copilot sessions', accent: '#93c5fd' },
  { id: 'Cursor', label: 'Cursor', logo: '/logos/cursor.png', desc: 'Cursor agent transcripts', accent: '#f9a8d4' },
  { id: 'Antigravity', label: 'Antigravity', logo: '/logos/antigravity.png', desc: 'Antigravity IDE agent', accent: '#a5b4fc' },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a])) as Record<AgentId, AgentMeta>;

export type EventKind = 'message' | 'code_edit' | 'artifact';

export interface RelayEvent {
  source?: string;
  role?: 'user' | 'assistant' | string;
  kind?: EventKind;
  content?: string;
  file?: string;
  path?: string;
  summary?: string;
  diff?: string;
  ts?: string;
}

export interface RelayArtifact {
  name: string;
  content: string;
  metadata?: string;
  source?: string;
}

export interface RelayTask {
  id: string;
  preview: string;
  source?: string;
}

export interface RelayMessage {
  type?: string;
  payload?: unknown;
  source?: string;
}

export interface RelayAgentMemory {
  status: 'connected' | 'handshaking' | 'idle' | 'error';
  transcriptPath?: string;
  eventCount?: number;
  events?: RelayEvent[];
  artifacts?: RelayArtifact[];
  tasks?: RelayTask[];
  messages?: RelayMessage[];
}

export interface RelayMemory {
  workspace: string;
  lastSync: string | null;
  agents: Partial<Record<AgentId, RelayAgentMemory>>;
  timeline: RelayEvent[];
}

export interface RelayProjectStats {
  totalEvents: number;
  lastSync: string | null;
  connectedAgents: number;
}

export interface RelayProject {
  id: string;
  name: string;
  workspacePath: string;
  apiKey?: string;
  createdAt?: string;
  updatedAt?: string;
  stats?: RelayProjectStats;
}

export interface RelayDashboardIr {
  project: string;
  currentTask: string;
  decisions: string;
  failures: string;
  architecture: string;
  compileBrief: string;
}

export interface RelayDashboard {
  workspace: string;
  lastSync: string | null;
  stats: {
    totalEvents: number;
    byKind: Record<string, number>;
    bySource: Record<string, number>;
    connectedAgents: number;
  };
  agents: { name: string; status: string; eventCount: number; transcriptPath?: string | null }[];
  handoff: { markdown: string; updatedAt?: string | null };
  ir: RelayDashboardIr;
  recentEdits: RelayEvent[];
  activity: { total: number; offset: number; limit: number; events: RelayEvent[] };
}

export interface MissionChatMessage {
  id: string;
  author: string;
  agent?: AgentId | null;
  role: 'user' | 'system';
  text: string;
  ts: string;
}

export interface MissionMeta {
  version: number;
  collaborators: string[];
  chat: MissionChatMessage[];
  updatedAt?: string;
}

async function relayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RELAY_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
  } catch {
    throw new Error(`Relay backend offline at ${RELAY_URL}. Start it with: relay serve`);
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || data.ok === false) {
    throw new Error((data.error as string) || `Relay request failed (${res.status})`);
  }
  return data as T;
}

export function listProjects() {
  return relayFetch<{ ok: true; projects: RelayProject[] }>('/api/projects');
}

export function createProject(workspacePath: string, name?: string) {
  return relayFetch<{ ok: true; project: RelayProject }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ workspacePath, name }),
  });
}

export function getProject(projectId: string) {
  return relayFetch<{ ok: true; project: RelayProject }>(`/api/projects/${projectId}`);
}

export function updateProjectName(projectId: string, name: string) {
  return relayFetch<{ ok: true; project: RelayProject }>(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function registerWorkspace(workspacePath: string, name?: string) {
  return relayFetch<{ ok: true; project: RelayProject }>('/api/register', {
    method: 'POST',
    body: JSON.stringify({ workspacePath, name }),
  });
}

export function sendHandshake(workspacePath: string, agent: AgentId, projectId?: string) {
  return relayFetch<{ ok: true; token: string; message: string }>('/api/handshake', {
    method: 'POST',
    body: JSON.stringify({ workspacePath, agent, projectId }),
  });
}

export function connectAgent(workspacePath: string, agent: AgentId, projectId?: string) {
  return relayFetch<{ ok: true; transcriptPath: string; eventCount: number; events: RelayEvent[] }>(
    '/api/connect',
    { method: 'POST', body: JSON.stringify({ workspacePath, agent, projectId }) },
  );
}

export function syncProject(projectId: string) {
  return relayFetch<{ ok: true; totalEvents: number; timelineCount: number; lastSync: string }>(
    `/api/projects/${projectId}/sync`,
    { method: 'POST' },
  );
}

export function syncWorkspace(workspacePath: string) {
  return relayFetch<{ ok: true; totalEvents: number; timelineCount: number; lastSync: string }>(
    '/api/sync',
    { method: 'POST', body: JSON.stringify({ workspacePath }) },
  );
}

export async function getMemory(workspacePath: string): Promise<RelayMemory> {
  const data = await relayFetch<{ ok: true; memory: RelayMemory }>(
    `/api/memory?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
  return data.memory;
}

export async function getProjectDashboard(
  projectId: string,
  params: { limit?: number; offset?: number; kind?: string; source?: string; role?: string } = {},
): Promise<{ project: RelayProject; dashboard: RelayDashboard }> {
  const q = new URLSearchParams();
  if (params.limit != null) q.set('limit', String(params.limit));
  if (params.offset != null) q.set('offset', String(params.offset));
  if (params.kind) q.set('kind', params.kind);
  if (params.source) q.set('source', params.source);
  if (params.role) q.set('role', params.role);
  const data = await relayFetch<{ ok: true; project: RelayProject; dashboard: RelayDashboard }>(
    `/api/projects/${projectId}/dashboard?${q}`,
  );
  return { project: data.project, dashboard: data.dashboard };
}

export async function pingRelay(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAY_URL}/api/health`);
    const data = await res.json();
    return res.ok && data.ok === true;
  } catch {
    return false;
  }
}

export function getMissionMeta(workspacePath: string) {
  return relayFetch<{ ok: true; meta: MissionMeta }>(
    `/api/mission-meta?workspacePath=${encodeURIComponent(workspacePath)}`,
  );
}

export function saveMissionMeta(workspacePath: string, meta: Partial<MissionMeta>) {
  return relayFetch<{ ok: true; meta: MissionMeta }>(
    `/api/mission-meta?workspacePath=${encodeURIComponent(workspacePath)}`,
    { method: 'PUT', body: JSON.stringify(meta) },
  );
}

export function isRedactedContent(text?: string | null): boolean {
  if (!text) return false;
  const s = text.trim();
  if (s === '[REDACTED]') return true;
  if (/^\[REDACTED\]\s*$/i.test(s)) return true;
  const stripped = s.replace(/\[REDACTED\]/gi, '').trim();
  return !stripped && /\[REDACTED\]/i.test(s);
}

export function filterTimeline(events: RelayEvent[]): RelayEvent[] {
  return events.filter((e) => {
    if (e.kind === 'message' || e.kind === 'artifact') {
      return !isRedactedContent(e.content);
    }
    return true;
  });
}
