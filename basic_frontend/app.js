const API = window.location.origin;

const AGENTS = [
  { id: 'Antigravity', icon: '⬡', cls: 'antigravity' },
  { id: 'Codex', icon: '⚡', cls: 'codex' },
  { id: 'Claude Code', icon: '◆', cls: 'claude' },
  { id: 'GitHub Copilot', icon: '◈', cls: 'copilot' },
  { id: 'Cursor', icon: '▣', cls: 'cursor' },
];

const MEMORY_FILES = [
  { key: 'project', label: 'Project', file: 'project.md' },
  { key: 'currentTask', label: 'Tasks', file: 'current_task.md' },
  { key: 'decisions', label: 'Decisions', file: 'decisions.md' },
  { key: 'failures', label: 'Failures', file: 'failures.md' },
  { key: 'architecture', label: 'Architecture', file: 'architecture.md' },
  { key: 'compileBrief', label: 'Compile brief', file: 'compile_brief.md' },
];

const FILTER_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'user', label: 'User' },
  { id: 'assistant', label: 'Agent' },
  { id: 'code_edit', label: 'Edits' },
  ...AGENTS.map((a) => ({ id: a.id, label: a.id.split(' ')[0] })),
];

const SRC_BADGE = {
  Antigravity: 'badge-antigravity',
  Codex: 'badge-codex',
  'Claude Code': 'badge-claude',
  'GitHub Copilot': 'badge-copilot',
  Cursor: 'badge-cursor',
};

let projects = [];
let activeProject = null;
let dashboard = null;
let currentView = 'overview';
let activityFilter = 'all';
let activityOffset = 0;
let activityHasMore = false;
let activityEvents = [];
let memoryTab = 'project';
let selectedFile = null;
let syncBusy = false;
let setupProjectId = null;
const agentState = Object.fromEntries(AGENTS.map((a) => [a.id, { status: 'idle', busy: false }]));

function $(id) {
  return document.getElementById(id);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeClass(source) {
  return SRC_BADGE[source] || '';
}

function formatDiff(diff) {
  return String(diff || '')
    .split('\n')
    .map((line) => {
      const safe = esc(line);
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="add">${safe}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="del">${safe}</span>`;
      return safe;
    })
    .join('\n');
}

function renderMarkdown(text) {
  if (!text || !text.trim()) return '<span class="muted">No content yet.</span>';
  return esc(text)
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function getUrlParams() {
  return new URLSearchParams(window.location.search);
}

function setUrlProject(projectId) {
  const url = new URL(window.location.href);
  if (projectId) {
    url.searchParams.set('project', projectId);
    url.searchParams.delete('setup');
  } else {
    url.searchParams.delete('project');
    url.searchParams.delete('setup');
  }
  window.history.replaceState({}, '', url);
}

async function checkHealth() {
  try {
    const res = await fetch(`${API}/api/health`);
    if (!res.ok) throw new Error('offline');
    $('statusDot').classList.add('live');
    $('statusText').textContent = 'Live';
  } catch {
    $('statusDot').classList.remove('live');
    $('statusText').textContent = 'Offline — run relay serve';
  }
}

async function loadProjects() {
  const res = await fetch(`${API}/api/projects`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error);
  projects = data.projects || [];
  renderProjectGrid();
}

function renderProjectGrid() {
  const grid = $('projectGrid');
  if (!projects.length) {
    grid.innerHTML = `
      <div class="empty empty-wide">
        <div class="empty-icon">⬡</div>
        <h3>No projects yet</h3>
        <p>Run <code>relay init</code> in a project folder, or click Add project above.</p>
      </div>`;
    return;
  }

  grid.innerHTML = projects
    .map((p) => {
      const stats = p.stats || {};
      const lastSync = stats.lastSync
        ? new Date(stats.lastSync).toLocaleString()
        : 'Never synced';
      return `
        <article class="project-card" data-id="${esc(p.id)}">
          <div class="project-card-top">
            <span class="project-card-icon">⬡</span>
            <div>
              <h3>${esc(p.name)}</h3>
              <p class="project-card-path" title="${esc(p.workspacePath)}">${esc(shortPath(p.workspacePath))}</p>
            </div>
          </div>
          <div class="project-card-stats">
            <span>${stats.totalEvents || 0} events</span>
            <span>${stats.connectedAgents || 0} agents</span>
          </div>
          <div class="project-card-foot">
            <span class="muted">${esc(lastSync)}</span>
            <span class="project-card-link">Open →</span>
          </div>
        </article>`;
    })
    .join('');

  grid.querySelectorAll('.project-card').forEach((card) => {
    card.addEventListener('click', () => openProject(card.dataset.id));
  });
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

function showScreen(name) {
  $('screenHome').classList.toggle('active', name === 'home');
  $('screenProject').classList.toggle('active', name === 'project');
}

async function openProject(projectId, { showSetup = false } = {}) {
  try {
    const res = await fetch(`${API}/api/projects/${projectId}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    activeProject = data.project;
    setUrlProject(projectId);
    showScreen('project');

    $('projectTitle').textContent = activeProject.name;
    $('projectPath').textContent = activeProject.workspacePath;
    $('projectNameInput').value = activeProject.name;
    $('apiKeyDisplay').textContent = activeProject.apiKey || '—';
    $('workspacePathDisplay').textContent = activeProject.workspacePath;

    if (showSetup) {
      setupProjectId = projectId;
      $('setupNameInput').value = activeProject.name;
      $('setupApiKey').textContent = activeProject.apiKey || '—';
      $('setupModal').hidden = false;
    }

    switchView('overview');
    await refreshDashboard(true, true);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function goHome() {
  activeProject = null;
  dashboard = null;
  setUrlProject(null);
  showScreen('home');
  loadProjects();
}

async function addProject() {
  const workspacePath = $('addWsPath').value.trim();
  const name = $('addProjectName').value.trim();
  if (!workspacePath) return toast('Enter a workspace path', 'err');

  try {
    const res = await fetch(`${API}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspacePath, name: name || undefined }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    $('addModal').hidden = true;
    $('addWsPath').value = '';
    $('addProjectName').value = '';
    toast(`Added ${data.project.name}`);

    setupProjectId = data.project.id;
    $('setupNameInput').value = data.project.name;
    $('setupApiKey').textContent = data.project.apiKey;
    $('setupModal').hidden = false;
    await loadProjects();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function saveProjectName(fromSetup = false) {
  if (!activeProject && !setupProjectId) return;
  const projectId = setupProjectId || activeProject.id;
  const name = fromSetup ? $('setupNameInput').value.trim() : $('projectNameInput').value.trim();
  if (!name) return toast('Enter a project name', 'err');

  try {
    const res = await fetch(`${API}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    if (activeProject && activeProject.id === projectId) {
      activeProject = data.project;
      $('projectTitle').textContent = activeProject.name;
      $('projectNameInput').value = activeProject.name;
      $('apiKeyDisplay').textContent = activeProject.apiKey;
    }
    toast('Project name saved');
    await loadProjects();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed', 'err');
  }
}

async function refreshDashboard(resetActivity = false, fullSync = false) {
  if (!activeProject || syncBusy) return;
  syncBusy = true;
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = 'Syncing…';

  try {
    if (fullSync) {
      await fetch(`${API}/api/projects/${activeProject.id}/sync`, { method: 'POST' });
    }

    if (resetActivity) activityOffset = 0;

    const params = new URLSearchParams({
      limit: '50',
      offset: String(activityOffset),
    });

    if (activityFilter === 'user' || activityFilter === 'assistant') {
      params.set('role', activityFilter);
    } else if (activityFilter === 'code_edit') {
      params.set('kind', 'code_edit');
    } else if (activityFilter !== 'all') {
      params.set('source', activityFilter);
    }

    const res = await fetch(`${API}/api/projects/${activeProject.id}/dashboard?${params}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    activeProject = data.project;
    dashboard = data.dashboard;

    $('apiKeyDisplay').textContent = activeProject.apiKey || '—';

    for (const agent of dashboard.agents || []) {
      if (agentState[agent.name]) {
        agentState[agent.name].status = agent.status;
        agentState[agent.name].eventCount = agent.eventCount;
      }
    }

    if (resetActivity) {
      activityEvents = dashboard.activity.events || [];
    } else if (activityOffset > 0) {
      activityEvents = [...activityEvents, ...(dashboard.activity.events || [])];
    } else {
      activityEvents = dashboard.activity.events || [];
    }

    activityHasMore =
      activityOffset + (dashboard.activity.events || []).length < dashboard.activity.total;
    renderAll();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    syncBusy = false;
    $('syncBtn').disabled = false;
    $('syncBtn').textContent = 'Sync';
  }
}

function renderAll() {
  renderAgents();
  renderStats();
  renderOverview();
  renderActivityFilters();
  renderActivity();
  renderEdits();
  renderMemoryTabs();
  renderMemoryBody();
  renderFileTree();
  $('loadMoreBtn').hidden = !activityHasMore;
}

function renderStats() {
  const row = $('statsRow');
  if (!dashboard) {
    row.innerHTML = '';
    return;
  }
  const s = dashboard.stats;
  const lastSync = dashboard.lastSync
    ? new Date(dashboard.lastSync).toLocaleString()
    : 'never';
  row.innerHTML = [
    { value: s.totalEvents, label: 'Timeline events' },
    { value: s.byKind.code_edit + s.byKind.artifact, label: 'Code edits' },
    { value: s.connectedAgents, label: 'Connected agents' },
    { value: lastSync.split(',')[1]?.trim() || lastSync, label: 'Last sync' },
  ]
    .map(
      (c) => `
    <div class="stat-card">
      <div class="stat-value">${esc(String(c.value))}</div>
      <div class="stat-label">${esc(c.label)}</div>
    </div>`
    )
    .join('');
}

function renderOverview() {
  if (!dashboard) {
    $('handoffBody').innerHTML = emptyHtml('Loading…', 'Sync to load project memory.');
    $('tasksBody').innerHTML = '';
    $('overviewEdits').innerHTML = '';
    return;
  }

  $('handoffMeta').textContent = dashboard.lastSync
    ? `Updated ${new Date(dashboard.lastSync).toLocaleString()}`
    : 'relay_context.md';

  $('handoffBody').innerHTML = renderMarkdown(dashboard.handoff.markdown);
  $('tasksBody').innerHTML = renderMarkdown(dashboard.ir.currentTask);

  const edits = dashboard.recentEdits.slice(0, 5);
  $('overviewEdits').innerHTML = edits.length
    ? edits.map((e) => editCardHtml(e, false)).join('')
    : '<div class="muted" style="padding:16px">No code edits yet.</div>';
}

function editCardHtml(e, expandable = true) {
  const file = e.file || e.path || 'Unknown file';
  const summary = e.summary
    ? `<div class="event-text" style="margin-bottom:8px;color:var(--text-2)">${esc(e.summary)}</div>`
    : '';
  const diff = e.diff
    ? `<pre class="diff">${formatDiff(e.diff)}</pre>`
    : '<div class="muted">No diff stored for this edit.</div>';

  if (!expandable) {
    return `
      <div class="edit-card">
        <div class="edit-card-head">
          <span class="badge ${badgeClass(e.source)}">${esc(e.source || '')}</span>
          <span class="event-file">${esc(file)}</span>
          <span class="event-time">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
        </div>
        <div class="edit-card-body">${summary}${diff}</div>
      </div>`;
  }

  return `
    <div class="edit-card">
      <div class="edit-card-head" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">
        <span class="badge ${badgeClass(e.source)}">${esc(e.source || '')}</span>
        <span class="event-file">${esc(file)}</span>
        <span class="event-time">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
      </div>
      <div class="edit-card-body" hidden>${summary}${diff}</div>
    </div>`;
}

function renderEdits() {
  const grid = $('editsGrid');
  if (!dashboard || !dashboard.recentEdits.length) {
    grid.innerHTML = emptyHtml('No edits', 'Code edits from all agents appear here.');
    return;
  }
  grid.innerHTML = dashboard.recentEdits.map((e) => editCardHtml(e, true)).join('');
}

function renderActivityFilters() {
  const bar = $('activityFilters');
  bar.innerHTML = FILTER_OPTIONS.map(
    (f) =>
      `<button class="chip ${activityFilter === f.id ? 'active' : ''}" data-filter="${esc(f.id)}">${esc(f.label)}</button>`
  ).join('');

  bar.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      activityFilter = btn.dataset.filter;
      activityOffset = 0;
      refreshDashboard(true, true);
    });
  });
}

function eventHtml(e) {
  const kind = e.kind || 'message';
  const isEdit = kind === 'code_edit' || kind === 'artifact';
  const avatarCls = isEdit ? 'edit' : e.role || 'assistant';
  const avatar = isEdit ? '✎' : e.role === 'user' ? 'U' : 'A';

  let body = '';
  if (isEdit) {
    const file = e.file || e.path;
    body = `
      ${file ? `<div class="event-file">${esc(file)}</div>` : ''}
      ${e.summary ? `<div class="event-text">${esc(e.summary)}</div>` : ''}
      ${e.diff ? `<pre class="diff" style="margin-top:8px">${formatDiff(e.diff)}</pre>` : ''}`;
  } else {
    body = `<div class="event-text">${esc(e.content || '')}</div>`;
  }

  return `
    <div class="event">
      <div class="event-avatar ${avatarCls}">${avatar}</div>
      <div class="event-card">
        <div class="event-meta">
          <span class="badge ${badgeClass(e.source)}">${esc(e.source || '')}</span>
          <span class="muted">${esc(isEdit ? kind.replace('_', ' ') : e.role || 'message')}</span>
          <span class="event-time">${e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
        </div>
        ${body}
      </div>
    </div>`;
}

function renderActivity() {
  const feed = $('activityFeed');
  if (!dashboard) {
    feed.innerHTML = emptyHtml('No activity', 'Connect agents and sync to populate the timeline.');
    return;
  }
  if (!activityEvents.length) {
    feed.innerHTML = emptyHtml('No events', 'Try a different filter or connect an agent.');
    return;
  }

  const byDay = new Map();
  for (const e of activityEvents) {
    const day = e.ts ? e.ts.slice(0, 10) : 'Unknown';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  feed.innerHTML = [...byDay.entries()]
    .map(
      ([day, events]) => `
      <div class="day-group">
        <div class="day-label">${esc(day)} · ${events.length} events</div>
        ${events.map(eventHtml).join('')}
      </div>`
    )
    .join('');
}

function renderMemoryTabs() {
  const bar = $('memoryTabs');
  bar.innerHTML = MEMORY_FILES.map(
    (f) =>
      `<button class="memory-tab ${memoryTab === f.key ? 'active' : ''}" data-tab="${f.key}">${esc(f.label)}</button>`
  ).join('');

  bar.querySelectorAll('.memory-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      memoryTab = btn.dataset.tab;
      selectedFile = null;
      renderMemoryTabs();
      renderMemoryBody();
    });
  });
}

function renderMemoryBody() {
  const body = $('memoryBody');
  if (!dashboard) {
    body.innerHTML = emptyHtml('Memory files', 'IR markdown maintained by your agents lives here.');
    return;
  }

  let content = dashboard.ir[memoryTab] || '';
  if (selectedFile) {
    const map = Object.fromEntries(MEMORY_FILES.map((f) => [f.file, f.key]));
    const key = map[selectedFile];
    if (key) content = dashboard.ir[key] || content;
  }

  body.innerHTML = renderMarkdown(content);
}

function renderFileTree() {
  const tree = $('fileTree');
  if (!dashboard || !dashboard.fileTree.length) {
    tree.innerHTML = '<div class="muted">No files</div>';
    return;
  }

  function nodeHtml(node, depth = 0) {
    const indent = '<span class="tree-indent"></span>'.repeat(depth);
    if (node.type === 'dir') {
      return `
        <div>${indent}<span class="muted">📁 ${esc(node.name)}</span></div>
        ${(node.children || []).map((c) => nodeHtml(c, depth + 1)).join('')}`;
    }
    const active = selectedFile === node.path ? 'active' : '';
    return `
      <div class="tree-item ${active}" data-path="${esc(node.path)}">
        ${indent}📄 ${esc(node.name)}
      </div>`;
  }

  tree.innerHTML = dashboard.fileTree.map((n) => nodeHtml(n)).join('');

  tree.querySelectorAll('.tree-item').forEach((el) => {
    el.addEventListener('click', () => {
      selectedFile = el.dataset.path;
      const match = MEMORY_FILES.find((f) => f.file === selectedFile);
      if (match) memoryTab = match.key;
      switchView('memory');
      renderFileTree();
      renderMemoryTabs();
      renderMemoryBody();
    });
  });
}

function renderAgents() {
  const list = $('agentList');
  if (!activeProject) {
    list.innerHTML = '<div class="muted">Open a project</div>';
    return;
  }

  list.innerHTML = AGENTS.map((agent) => {
    const state = agentState[agent.id];
    const connected = state.status === 'connected';
    const count = state.eventCount ? `${state.eventCount} events` : 'Not connected';
    return `
      <div class="agent-row ${connected ? 'connected' : ''}">
        <div class="agent-icon ${agent.cls}">${agent.icon}</div>
        <div class="agent-meta">
          <div class="agent-name">${esc(agent.id)}</div>
          <div class="agent-sub">${esc(count)}</div>
        </div>
        <button class="agent-connect" data-agent="${esc(agent.id)}" ${state.busy ? 'disabled' : ''}>
          ${state.busy ? '…' : connected ? '↻' : 'Connect'}
        </button>
      </div>`;
  }).join('');

  list.querySelectorAll('.agent-connect').forEach((btn) => {
    btn.addEventListener('click', () => connectAgent(btn.dataset.agent));
  });
}

async function connectAgent(agentId) {
  if (!activeProject || agentState[agentId].busy) return;
  agentState[agentId].busy = true;
  renderAgents();

  try {
    await fetch(`${API}/api/handshake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: activeProject.id, agent: agentId }),
    });
    await new Promise((r) => setTimeout(r, 1500));

    const res = await fetch(`${API}/api/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: activeProject.id, agent: agentId }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    agentState[agentId].status = 'connected';
    agentState[agentId].eventCount = data.eventCount;
    toast(`${agentId} connected`);
    refreshDashboard(true, true);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    agentState[agentId].busy = false;
    renderAgents();
  }
}

function emptyHtml(title, desc) {
  return `
    <div class="empty">
      <div class="empty-icon">⬡</div>
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
    </div>`;
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('#mainTabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  document.querySelectorAll('#screenProject .view').forEach((v) => {
    const id = `view${view.charAt(0).toUpperCase()}${view.slice(1)}`;
    v.classList.toggle('active', v.id === id);
  });
}

function bindUi() {
  $('addProjectBtn').addEventListener('click', () => {
    $('addModal').hidden = false;
  });
  $('closeAddModal').addEventListener('click', () => {
    $('addModal').hidden = true;
  });
  $('cancelAddBtn').addEventListener('click', () => {
    $('addModal').hidden = true;
  });
  $('confirmAddBtn').addEventListener('click', addProject);
  $('addWsPath').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addProject();
  });

  $('backBtn').addEventListener('click', goHome);
  $('syncBtn').addEventListener('click', () => refreshDashboard(true, true));
  $('loadMoreBtn').addEventListener('click', () => {
    activityOffset += 50;
    refreshDashboard(false, false);
  });

  document.querySelectorAll('#mainTabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });

  $('saveNameBtn').addEventListener('click', () => saveProjectName(false));
  $('copyKeyBtn').addEventListener('click', () => copyText($('apiKeyDisplay').textContent));

  $('closeSetupModal').addEventListener('click', () => {
    $('setupModal').hidden = true;
    setupProjectId = null;
  });
  $('copySetupKeyBtn').addEventListener('click', () => copyText($('setupApiKey').textContent));
  $('saveSetupBtn').addEventListener('click', () => saveProjectName(true));
  $('openProjectBtn').addEventListener('click', async () => {
    $('setupModal').hidden = true;
    if (setupProjectId) await openProject(setupProjectId);
    setupProjectId = null;
  });
}

async function init() {
  bindUi();
  checkHealth();
  setInterval(checkHealth, 15000);

  try {
    await loadProjects();
  } catch (err) {
    toast(err.message, 'err');
  }

  const params = getUrlParams();
  const setupId = params.get('setup');
  const projectId = params.get('project');

  if (setupId) {
    await openProject(setupId, { showSetup: true });
  } else if (projectId) {
    await openProject(projectId);
  }

  setInterval(() => {
    if (activeProject) refreshDashboard(false, false);
  }, 12000);
}

init();
