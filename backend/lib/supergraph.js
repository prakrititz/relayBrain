const graphs = new Map();

function unionKey(workspaceId) {
  return workspaceId || "default";
}

function ingest(workspaceId, { userId, edges }) {
  const key = unionKey(workspaceId);
  let g = graphs.get(key);
  if (!g) {
    g = { users: new Map(), edges: new Map() };
    graphs.set(key, g);
  }
  g.users.set(userId || "anon", edges || []);
  g.edges = new Map();
  for (const list of g.users.values()) {
    for (const e of list) {
      const from = e.from || e[0];
      const to = e.to || e[1];
      if (!from || !to) continue;
      if (!g.edges.has(from)) g.edges.set(from, new Set());
      g.edges.get(from).add(to);
    }
  }
  return snapshot(workspaceId);
}

function dependents(workspaceId, file) {
  const g = graphs.get(unionKey(workspaceId));
  if (!g) return [];
  const out = [];
  for (const [from, tos] of g.edges) {
    if (tos.has(file)) out.push(from);
  }
  return out;
}

function snapshot(workspaceId) {
  const g = graphs.get(unionKey(workspaceId));
  if (!g) return { users: 0, edges: [] };
  const edges = [];
  for (const [from, tos] of g.edges) for (const to of tos) edges.push({ from, to });
  return { users: g.users.size, edges };
}

module.exports = { ingest, dependents, snapshot };
