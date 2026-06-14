const { getMemory } = require('../relay');
const { readIrFiles, buildRelayTree } = require('./relayStore');

function countByKind(events) {
  const counts = { message: 0, code_edit: 0, artifact: 0, other: 0 };
  for (const e of events) {
    const k = e.kind || 'message';
    if (counts[k] !== undefined) counts[k] += 1;
    else counts.other += 1;
  }
  return counts;
}

function countBySource(events) {
  const counts = {};
  for (const e of events) {
    const src = e.source || 'Unknown';
    counts[src] = (counts[src] || 0) + 1;
  }
  return counts;
}

function groupEventsByDay(events) {
  const groups = new Map();
  for (const e of events) {
    const day = e.ts ? e.ts.slice(0, 10) : 'unknown';
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(e);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, items]) => ({ day, count: items.length, events: items }));
}

function paginateEvents(events, { limit = 40, offset = 0, kind, source, role } = {}) {
  let filtered = events;
  if (kind === 'code_edit') {
    filtered = filtered.filter((e) => e.kind === 'code_edit' || e.kind === 'artifact');
  } else if (kind && kind !== 'all') {
    filtered = filtered.filter((e) => e.kind === kind);
  }
  if (source && source !== 'all') {
    filtered = filtered.filter((e) => e.source === source);
  }
  if (role === 'user' || role === 'assistant') {
    filtered = filtered.filter((e) => e.role === role);
  }

  const total = filtered.length;
  const slice = filtered.slice(Math.max(0, offset), Math.max(0, offset) + limit);
  return { total, offset, limit, events: slice };
}

function buildAgentSummary(memory) {
  const agents = memory.agents || {};
  return Object.entries(agents).map(([name, data]) => ({
    name,
    status: data.status || 'idle',
    eventCount: data.eventCount || (data.events || []).length,
    transcriptPath: data.transcriptPath || null,
  }));
}

function buildDashboard(workspacePath, options = {}) {
  const memory = getMemory(workspacePath);
  const timeline = Array.isArray(memory.timeline) ? memory.timeline : [];
  const sorted = [...timeline].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

  const ir = readIrFiles(workspacePath);
  const tree = buildRelayTree(workspacePath);

  const recentEdits = sorted
    .filter((e) => e.kind === 'code_edit' || e.kind === 'artifact')
    .slice(-20)
    .reverse();

  const activityPage = paginateEvents(sorted, {
    limit: options.limit || 40,
    offset: options.offset || 0,
    kind: options.kind,
    source: options.source,
    role: options.role,
  });

  return {
    workspace: memory.workspace || workspacePath,
    lastSync: memory.lastSync || null,
    stats: {
      totalEvents: sorted.length,
      byKind: countByKind(sorted),
      bySource: countBySource(sorted),
      connectedAgents: buildAgentSummary(memory).filter((a) => a.status === 'connected').length,
    },
    agents: buildAgentSummary(memory),
    handoff: {
      markdown: ir['relay_context.md'] || '',
      updatedAt: memory.lastSync,
    },
    ir: {
      project: ir['project.md'] || '',
      currentTask: ir['current_task.md'] || '',
      decisions: ir['decisions.md'] || '',
      failures: ir['failures.md'] || '',
      architecture: ir['architecture.md'] || '',
      compileBrief: ir['compile_brief.md'] || '',
    },
    recentEdits,
    activity: activityPage,
    days: groupEventsByDay(sorted).slice(0, 14),
    fileTree: tree,
  };
}

module.exports = {
  buildDashboard,
  paginateEvents,
  groupEventsByDay,
};
