const { loadMemory, loadSession } = require("./store");
const { detectConflicts } = require("./conflicts");
const { mergeRoomViews } = require("./roomSync");

function tagMine(list, login) {
  return (list || []).map((item) => ({
    ...item,
    mine: item.ownerLogin ? item.ownerLogin === login : Boolean(item.mine),
  }));
}

function buildDashboard(project, memory) {
  const mem = stripMarkdownIr(memory || loadMemory(project.id));
  const login = loadSession().login || "local";
  // Outside a room `roomPeers` is empty and this is the local memory verbatim;
  // inside one it folds in every other machine's chats, edits and activity so
  // both sides of an ngrok link see the same feed.
  const view = mergeRoomViews(mem);
  return {
    project,
    stats: mem.stats || {},
    agents: view.agents,
    collaborators: mem.collaborators || [],
    activity: tagMine(view.activity, login),
    history: tagMine(view.history, login),
    timeline: tagMine(view.timeline, login),
    chats: tagMine(view.chats, login),
    edits: tagMine(view.edits, login),
    patches: mem.patches || mem.edits || [],
    lastAppliedLamport: mem.lastAppliedLamport || 0,
    conflicts: detectConflicts(mem),
    peers: view.peerLogins,
    memory: {
      historyCount: (view.history || mem.history || []).length,
      timelineCount: (view.timeline || []).length,
      chatCount: (view.chats || []).length,
      editCount: (view.edits || []).length,
      lastTranscriptSyncAt: mem.lastTranscriptSyncAt || project.lastSyncAt || 0,
    },
  };
}

function stripMarkdownIr(mem) {
  if (mem && mem.ir) delete mem.ir;
  return mem;
}

module.exports = { buildDashboard };
