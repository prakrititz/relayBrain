const { loadMemory, saveMemory } = require("./store");
const { loadLocalCollisions } = require("./collisionMetrics");

// What one machine publishes to the room, and what it stores for every other
// machine in the room. Kept in the same memory.json as local history so the
// dashboard can merge both without a second store — but in a separate
// `roomPeers` bucket, so a peer's history is never re-published as our own
// (which would echo back and forth and grow without bound).
const MAX_THREADS = 24;
const MAX_MESSAGES = 80;
const MAX_EDITS = 200;
const MAX_ACTIVITY = 60;
const MAX_TIMELINE = 40;
// Transcript text is clipped to 8000 chars locally; at 24 threads x 80 messages
// that is a 15MB request per poll over a home-broadband tunnel. Peers get a
// shorter clip — enough to read the conversation, small enough to send often.
const MAX_MESSAGE_CHARS = 3000;
const PEER_TTL_MS = 6 * 60 * 60 * 1000;

function trimThread(thread) {
  return {
    ...thread,
    messages: (thread.messages || []).slice(-MAX_MESSAGES).map((m) => ({
      ...m,
      text: typeof m.text === "string" && m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}\n…` : m.text,
    })),
  };
}

/** The locally-owned slice of a workspace's memory, sized for the wire. */
function localSnapshot(memory, login, projectId) {
  const stats = { ...(memory.stats || {}) };
  // Prefer file-backed collision counters so room peers see the durable totals.
  if (projectId) stats.collisions = loadLocalCollisions(projectId);
  return {
    login,
    updatedAt: Date.now(),
    lastTranscriptSyncAt: memory.lastTranscriptSyncAt || 0,
    chats: (memory.chats || []).slice(0, MAX_THREADS).map(trimThread),
    timeline: (memory.timeline || []).slice(0, MAX_TIMELINE),
    activity: (memory.activity || []).slice(0, MAX_ACTIVITY),
    edits: (memory.edits || []).slice(0, MAX_EDITS),
    agents: (memory.agents || []).filter((a) => a.status === "connected"),
    stats,
  };
}

function sanitize(snapshot, login) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const owner = login || snapshot.login || "peer";
  const stamp = (rows, cap) =>
    (Array.isArray(rows) ? rows : []).slice(0, cap).map((row) => ({ ...row, ownerLogin: row.ownerLogin || owner, mine: false }));
  return {
    login: owner,
    updatedAt: Date.now(),
    lastTranscriptSyncAt: Number(snapshot.lastTranscriptSyncAt) || 0,
    chats: stamp(snapshot.chats, MAX_THREADS).map(trimThread),
    timeline: stamp(snapshot.timeline, MAX_TIMELINE),
    activity: stamp(snapshot.activity, MAX_ACTIVITY),
    edits: stamp(snapshot.edits, MAX_EDITS),
    agents: Array.isArray(snapshot.agents) ? snapshot.agents.slice(0, 20).map((a) => ({ ...a, ownerLogin: owner })) : [],
    stats: snapshot.stats && typeof snapshot.stats === "object" ? snapshot.stats : {},
  };
}

/**
 * Records what a peer reported. `key` is the peer's login on the host side and
 * the literal "host" on a guest, so a guest holds exactly one aggregated bucket
 * instead of one per room member.
 */
function savePeerSnapshot(projectId, key, snapshot, login) {
  const clean = sanitize(snapshot, login || key);
  if (!clean) return null;
  const memory = loadMemory(projectId);
  const peers = memory.roomPeers && typeof memory.roomPeers === "object" ? memory.roomPeers : {};
  const now = Date.now();
  for (const [name, row] of Object.entries(peers)) {
    if (now - (row?.updatedAt || 0) > PEER_TTL_MS) delete peers[name];
  }
  peers[key] = clean;
  memory.roomPeers = peers;
  saveMemory(projectId, memory);
  return clean;
}

function clearPeers(projectId) {
  const memory = loadMemory(projectId);
  if (!memory.roomPeers) return;
  delete memory.roomPeers;
  saveMemory(projectId, memory);
}

function peerSnapshots(memory, { exclude } = {}) {
  const peers = memory?.roomPeers && typeof memory.roomPeers === "object" ? memory.roomPeers : {};
  return Object.entries(peers)
    .filter(([key, row]) => row && key !== exclude && row.login !== exclude)
    .map(([, row]) => row);
}

function dedupeById(rows, sortKey) {
  const byId = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = row.id || `${row.ownerLogin}:${row.ts || row.updatedAt}`;
    const existing = byId.get(key);
    // Two sides of a room can both hold a thread (the guest's own chats come
    // back inside the host's aggregate). Keep the fuller copy rather than
    // whichever arrived last, so merging never truncates a conversation.
    if (!existing || (row.messages?.length || 0) > (existing.messages?.length || 0)) byId.set(key, row);
  }
  return [...byId.values()].sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
}

// Room snapshots do not ship the raw history array (too large for the tunnel).
// The Activity tab still reads history, so rebuild peer events from the chats
// that did cross the wire — otherwise the joiner's feed is empty while Chat
// and Code edits look fully synced.
function historyFromChats(chats) {
  const events = [];
  for (const thread of chats || []) {
    (thread.messages || []).forEach((m, i) => {
      events.push({
        id: `peer_${thread.ownerLogin || "peer"}_${thread.id}_${m.ts || 0}_${i}`,
        ts: m.ts || thread.updatedAt || 0,
        agent: thread.agent,
        ownerLogin: thread.ownerLogin,
        sessionId: thread.sessionId,
        role: m.role,
        kind: m.kind || "message",
        text: m.text || "",
        file: m.file || null,
        path: m.file || null,
        diff: "",
      });
    });
  }
  return events;
}

function mergeAgents(local, peers) {
  const agents = [];
  const seen = new Set();
  const add = (agent, fallbackOwner) => {
    if (!agent) return;
    const ownerLogin = agent.ownerLogin || fallbackOwner || "";
    const base = String(agent.id || agent.label || "agent")
      .toLowerCase()
      .replace(/\s+/g, "-");
    const key = `${ownerLogin}::${agent.label || base}`;
    if (seen.has(key)) return;
    seen.add(key);
    agents.push({
      ...agent,
      ownerLogin,
      id: ownerLogin ? `${ownerLogin}:${base}` : base,
    });
  };
  for (const agent of local || []) add(agent, agent.ownerLogin);
  for (const peer of peers) {
    for (const agent of peer.agents || []) add(agent, peer.login);
  }
  return agents;
}

/** Local view + every peer's view, deduped. Used for both the UI and the wire. */
function mergeRoomViews(memory, opts = {}) {
  const peers = peerSnapshots(memory, opts);
  if (!peers.length) {
    return {
      chats: memory.chats || [],
      timeline: memory.timeline || [],
      activity: memory.activity || [],
      edits: memory.edits || [],
      history: memory.history || [],
      agents: memory.agents || [],
      peerLogins: [],
    };
  }
  return {
    chats: dedupeById([...(memory.chats || []), ...peers.flatMap((p) => p.chats || [])], "updatedAt"),
    timeline: dedupeById([...(memory.timeline || []), ...peers.flatMap((p) => p.timeline || [])], "ts"),
    activity: dedupeById([...(memory.activity || []), ...peers.flatMap((p) => p.activity || [])], "ts").slice(0, 120),
    edits: dedupeById([...(memory.edits || []), ...peers.flatMap((p) => p.edits || [])], "ts").slice(0, 400),
    history: dedupeById(
      [...(memory.history || []), ...peers.flatMap((p) => historyFromChats(p.chats))],
      "ts"
    ).slice(0, 2000),
    agents: mergeAgents(memory.agents, peers),
    peerLogins: peers.map((p) => p.login).filter(Boolean),
  };
}

module.exports = { localSnapshot, savePeerSnapshot, peerSnapshots, mergeRoomViews, clearPeers };
