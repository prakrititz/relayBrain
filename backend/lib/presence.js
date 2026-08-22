const { EventEmitter } = require("events");

class Presence extends EventEmitter {
  constructor() {
    super();
    this.workspaces = new Map();
  }

  join(workspaceId, userId) {
    if (!workspaceId || !userId) return { count: 0, escalated: false };
    if (!this.workspaces.has(workspaceId)) this.workspaces.set(workspaceId, new Set());
    const set = this.workspaces.get(workspaceId);
    const before = set.size;
    set.add(userId);
    const escalated = before < 2 && set.size >= 2;
    this.emit("change", { workspaceId, userId, count: set.size, type: "join", escalated });
    if (escalated) this.emit("escalate", { workspaceId, users: [...set] });
    return { count: set.size, escalated };
  }

  leave(workspaceId, userId) {
    const set = this.workspaces.get(workspaceId);
    if (!set) return { count: 0 };
    set.delete(userId);
    const deescalated = set.size < 2;
    this.emit("change", { workspaceId, userId, count: set.size, type: "leave", deescalated });
    return { count: set.size, deescalated };
  }

  count(workspaceId) {
    return this.workspaces.get(workspaceId)?.size || 0;
  }
}

module.exports = { Presence };
