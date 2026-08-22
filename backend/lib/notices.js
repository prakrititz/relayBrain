const crypto = require("crypto");
const path = require("path");
const { dataDir } = require("./paths");
const { readJson, writeJson } = require("./store");

const MAX = 80;

function noticesPath() {
  return path.join(dataDir(), "notices.json");
}

function load() {
  const rows = readJson(noticesPath(), []);
  return Array.isArray(rows) ? rows : [];
}

function save(rows) {
  writeJson(noticesPath(), rows.slice(0, MAX));
  return rows;
}

function prune(rows, now = Date.now()) {
  return rows.filter((n) => {
    if (n.dismissedAt && now - n.dismissedAt > 7 * 24 * 60 * 60 * 1000) return false;
    if (n.readAt && !n.dismissedAt && now - n.readAt > 14 * 24 * 60 * 60 * 1000) return false;
    return true;
  });
}

function view(row) {
  return {
    id: row.id,
    type: row.type,
    key: row.key,
    title: row.title,
    body: row.body || "",
    action: row.action || null,
    payload: row.payload || null,
    workspaceId: row.workspaceId || null,
    ts: row.ts,
    readAt: row.readAt || null,
    dismissedAt: row.dismissedAt || null,
  };
}

function listNotices({ includeDismissed } = {}) {
  return prune(load())
    .filter((n) => includeDismissed || !n.dismissedAt)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map(view);
}

function unreadCount() {
  return listNotices().filter((n) => !n.readAt).length;
}

/**
 * Inserts a notice unless one with the same key is already sitting unread.
 * `revive` reopens a read/dismissed row (host came back, teammate rejoined).
 */
function pushNotice(input, { revive } = {}) {
  if (!input?.type || !input?.key || !input?.title) return null;
  const now = Date.now();
  const rows = prune(load(), now);
  const existing = rows.find((n) => n.key === input.key);
  if (existing && !revive) return null;
  if (existing && revive) {
    existing.title = input.title;
    existing.body = input.body || existing.body || "";
    existing.action = input.action || existing.action || null;
    existing.payload = input.payload || existing.payload || null;
    existing.workspaceId = input.workspaceId || existing.workspaceId || null;
    existing.ts = now;
    existing.readAt = null;
    existing.dismissedAt = null;
    save(rows);
    return view(existing);
  }
  const row = {
    id: `ntc_${crypto.randomBytes(6).toString("hex")}`,
    type: input.type,
    key: input.key,
    title: input.title,
    body: input.body || "",
    action: input.action || null,
    payload: input.payload || null,
    workspaceId: input.workspaceId || null,
    ts: now,
    readAt: null,
    dismissedAt: null,
  };
  save([row, ...rows.filter((n) => n.key !== input.key)]);
  return view(row);
}

function markRead(id) {
  const rows = load();
  const row = rows.find((n) => n.id === id);
  if (!row || row.readAt) return row ? view(row) : null;
  row.readAt = Date.now();
  save(rows);
  return view(row);
}

function markAllRead() {
  const now = Date.now();
  const rows = load().map((n) => (n.readAt || n.dismissedAt ? n : { ...n, readAt: now }));
  save(rows);
  return listNotices();
}

function dismissNotice(id) {
  const rows = load();
  const row = rows.find((n) => n.id === id);
  if (!row) return null;
  row.dismissedAt = Date.now();
  row.readAt = row.readAt || row.dismissedAt;
  save(rows);
  return view(row);
}

function dismissByKey(key) {
  if (!key) return 0;
  const now = Date.now();
  let count = 0;
  const rows = load().map((n) => {
    if (n.key !== key || n.dismissedAt) return n;
    count += 1;
    return { ...n, dismissedAt: now, readAt: n.readAt || now };
  });
  if (count) save(rows);
  return count;
}

module.exports = {
  listNotices,
  unreadCount,
  pushNotice,
  markRead,
  markAllRead,
  dismissNotice,
  dismissByKey,
};
