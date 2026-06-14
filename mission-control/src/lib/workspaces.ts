// Workspace registry in localStorage (single-user, local machine).

export interface Workspace {
  id: string;
  name: string;
  full: string;
  source: 'local';
  localPath: string;
  relayProjectId?: string;
  active: boolean;
}

const STORAGE_KEY = 'relay_workspaces';
export const WORKSPACES_CHANGED_EVENT = 'relay:workspaces-changed';

function isRealWorkspace(w: unknown): w is Workspace {
  return (
    !!w &&
    typeof w === 'object' &&
    typeof (w as Workspace).localPath === 'string' &&
    (w as Workspace).localPath.length > 0
  );
}

export function loadWorkspaces(): Workspace[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const real = parsed.filter(isRealWorkspace);
    if (real.length && !real.some((w) => w.active)) real[0].active = true;
    return real;
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: Workspace[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  window.dispatchEvent(new CustomEvent(WORKSPACES_CHANGED_EVENT));
}

export function badgeFromName(full: string): string {
  const leaf = full.split(/[/\\]/).filter(Boolean).pop() || full;
  return leaf.slice(0, 2).toUpperCase();
}

export function getActiveWorkspace(workspaces: Workspace[]): Workspace | null {
  return workspaces.find((w) => w.active) || null;
}
