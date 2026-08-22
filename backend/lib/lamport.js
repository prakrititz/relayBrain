const clocks = new Map();

function tick(workspaceId, incoming = 0) {
  const key = workspaceId || "global";
  const next = Math.max((clocks.get(key) || 0) + 1, Number(incoming) + 1);
  clocks.set(key, next);
  return next;
}

function peek(workspaceId) {
  return clocks.get(workspaceId || "global") || 0;
}

module.exports = { tick, peek };
