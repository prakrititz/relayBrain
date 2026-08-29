export type User = {
  id: string;
  login: string;
  name: string;
  avatarUrl: string;
};

export type Project = {
  id: string;
  name: string;
  initials: string;
  color: string;
  path: string;
  remoteUrl: string | null;
  apiKey: string;
  createdAt: number;
  lastSyncAt: number;
};

export type AgentStatus = "idle" | "handshaking" | "connected" | "error";

export type Agent = {
  id: string;
  label: string;
  status: AgentStatus;
  lastActiveAt: number;
  sessionId?: string;
  ownerId?: string;
  ownerLogin?: string;
};

export type Collaborator = User & {
  online: boolean;
  agentActive: boolean;
  agentLabel: string | null;
  role?: string;
  source?: string;
  inRoom?: boolean;
  permission?: string | null;
};

export type RoomInvite = {
  id: string;
  login: string;
  state: "pending" | "accepted" | "expired" | "revoked";
  createdAt: number;
  expiresAt: number;
  invitedBy: string | null;
  acceptedAt: number | null;
};

export type NoticeType =
  | "invite"
  | "joined"
  | "left"
  | "host_offline"
  | "host_online"
  | "replay_rejected";

export type Notice = {
  id: string;
  type: NoticeType;
  key: string;
  title: string;
  body: string;
  action?: "join" | null;
  payload?: {
    hostLogin?: string;
    roomId?: string;
    gistId?: string;
    url?: string;
    projectName?: string;
    projectId?: string;
    login?: string;
  } | null;
  workspaceId?: string | null;
  ts: number;
  readAt?: number | null;
};

export type OpenRoom = {
  hostLogin: string;
  url: string;
  roomId: string;
  projectName?: string | null;
  invited: boolean;
  updatedAt?: string | null;
  gistId?: string | null;
};

export type Room = {
  role: string;
  url: string;
  open?: boolean;
  live?: boolean;
  roomId?: string | null;
  hostLogin?: string | null;
  repoKey?: string | null;
  hostProjectId?: string | null;
  hostProjectName?: string | null;
  hostWorkspacePath?: string | null;
  projectId?: string | null;
  projectPath?: string | null;
  startedAt?: string;
  /** Guests only: is the host answering? Undefined on a host or solo install. */
  hostReachable?: boolean;
  lastHostContactAt?: number | null;
};

export type ActivityItem = {
  id: string;
  kind: string;
  agent: string;
  ownerLogin: string;
  mine: boolean;
  text: string;
  ts: number;
};

export type TimelineEvent = { type: string; text?: string; file?: string };

export type TimelineSegment = {
  id: string;
  agent: string;
  ownerLogin: string;
  mine: boolean;
  ts: number;
  title: string;
  events: TimelineEvent[];
};

export type ChatMessage = { role: string; text: string; ts?: number; kind?: string; file?: string };

export type ChatThread = {
  id: string;
  agent: string;
  ownerLogin: string;
  mine: boolean;
  sessionId?: string;
  updatedAt?: number;
  messages: ChatMessage[];
};

export type HistoryEvent = {
  id: string;
  ts: number;
  tsIso?: string;
  agent: string;
  ownerLogin: string;
  sessionId?: string;
  role: string;
  kind: string;
  text: string;
  file?: string | null;
  path?: string | null;
  diff?: string;
  mine?: boolean;
};

export type CodeEdit = {
  id: string;
  agent: string;
  ownerLogin: string;
  mine: boolean;
  file: string;
  ts: number;
  diff: string;
  lamport?: number;
  binary?: boolean;
};

export type FileLock = {
  filePath: string;
  agentId: string;
  claimedAt: number;
  ttlMs: number;
  expiresAt: number;
  mode?: "read" | "write";
  lastHeartbeat?: number;
  readers?: string[];
  escalated?: boolean;
  workspaceId?: string | null;
  source?: string;
  holder?: { label?: string; login?: string } | null;
  /** Recently released, kept briefly so short-lived claims stay visible. */
  released?: boolean;
  releasedAt?: number;
};

export type CollisionMemberStats = {
  ownerLogin: string;
  claimsBlocked: number;
  patchesBlocked: number;
  patchesSkipped: number;
  patchesDeferred: number;
  mergesFlagged: number;
  totalSaved: number;
  updatedAt?: number;
};

export type CollisionStats = {
  claimsBlocked: number;
  patchesBlocked: number;
  patchesSkipped: number;
  patchesDeferred: number;
  mergesFlagged: number;
  totalSaved: number;
  scope?: "solo" | "room";
  updatedAt?: number;
  peerLogins?: string[];
  byMember?: CollisionMemberStats[];
  recent?: { kind: string; ts: number; file?: string; agentId?: string; holder?: string; reason?: string; ownerLogin?: string }[];
};

export type Dashboard = {
  project: Project;
  stats: { events?: number; agents?: number; patches?: number; collisions?: CollisionStats };
  agents: Agent[];
  collaborators: Collaborator[];
  activity: ActivityItem[];
  history: HistoryEvent[];
  timeline: TimelineSegment[];
  chats: ChatThread[];
  edits: CodeEdit[];
  conflicts: { file: string; agents: string[] }[];
  memory: { historyCount?: number; timelineCount: number; chatCount: number; editCount: number; lastTranscriptSyncAt?: number };
  locks: FileLock[];
  /** Files agents are currently reading. Presence only — these take no lock. */
  reads?: {
    filePath: string;
    agentId: string;
    at: number;
    ttlMs?: number;
    expiresAt?: number;
    holder?: { label?: string; login?: string } | null;
  }[];
  patches?: CodeEdit[];
  lastAppliedLamport?: number;
  /** Logins of other machines in the room whose history is folded into this view. */
  peers?: string[];
  /** Host-only, local-only: outstanding invitations to this room. */
  invites?: RoomInvite[];
  /** Rooms hosted by collaborators of this repo that we were invited to. */
  openRooms?: OpenRoom[];
  graph?: {
    lockDepth: number;
    fileCount: number;
    edgeCount: number;
    cycles: string[][];
    languages?: string[];
    unresolvable: { from: string; spec: string; reason: string }[];
    nodes: { id: string; cyclic?: boolean; locked?: boolean; dependents: string[]; imports: string[] }[];
    edges: { from: string; to: string }[];
  };
  room?: Room | null;
};

export type TabId =
  | "activity"
  | "chat"
  | "edits"
  | "locks"
  | "team"
  | "memory"
  | "settings";
