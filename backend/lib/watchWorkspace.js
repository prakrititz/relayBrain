const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const SKIP = new Set(["node_modules", ".git", ".next", ".relay", "out"]);

class WorkspaceWatcher extends EventEmitter {
  constructor() {
    super();
    this.watchers = new Map();
  }

  watch(workspacePath, workspaceId) {
    if (!workspacePath || this.watchers.has(workspacePath) || !fs.existsSync(workspacePath)) return;
    try {
      const watcher = fs.watch(workspacePath, { recursive: true }, (event, filename) => {
        if (!filename) return;
        const rel = String(filename).replace(/\\/g, "/");
        if ([...SKIP].some((s) => rel.split("/").includes(s))) return;
        this.emit("change", { workspacePath, workspaceId, file: rel, event });
      });
      watcher.on("error", () => this.unwatch(workspacePath));
      this.watchers.set(workspacePath, watcher);
    } catch {
      /* fs.watch recursive unsupported — skip, Stop hook still fires */
    }
  }

  unwatch(workspacePath) {
    const w = this.watchers.get(workspacePath);
    if (w) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
      this.watchers.delete(workspacePath);
    }
  }
}

module.exports = { WorkspaceWatcher };
