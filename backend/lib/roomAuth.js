const crypto = require("crypto");

// A shared room is reachable by anyone who learns the tunnel URL, and it hands
// out the whole working tree, every agent transcript, and write access to the
// lock table. Membership therefore has to be proven, not assumed.
//
// Two credentials, with different lifetimes:
//   invite code  — issued by the host to one named person, single use, expires.
//   member token — minted when an invite is redeemed, presented on every
//                  subsequent request for as long as the room lasts.
// Only hashes are ever written to room.json, so a leaked room file cannot be
// replayed to rejoin the room.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_BYTES = 24;

function hash(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function mint(prefix) {
  return `${prefix}_${crypto.randomBytes(SECRET_BYTES).toString("hex")}`;
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normLogin(login) {
  return String(login || "").trim().toLowerCase();
}

function invitesOf(room) {
  return Array.isArray(room?.invites) ? room.invites : [];
}

function inviteState(invite, now = Date.now()) {
  if (invite.revokedAt) return "revoked";
  if (invite.acceptedAt) return "accepted";
  if (invite.expiresAt && now > invite.expiresAt) return "expired";
  return "pending";
}

function createInvite(room, { login, ttlMs, invitedBy } = {}) {
  const target = normLogin(login);
  if (!target) return { ok: false, error: "login_required" };
  const code = mint("rli");
  const now = Date.now();
  const invite = {
    id: `inv_${crypto.randomBytes(6).toString("hex")}`,
    login: target,
    codeHash: hash(code),
    createdAt: now,
    expiresAt: now + (Number(ttlMs) || INVITE_TTL_MS),
    invitedBy: normLogin(invitedBy) || null,
    acceptedAt: null,
    revokedAt: null,
  };
  room.invites = [...invitesOf(room).filter((i) => inviteState(i) !== "expired"), invite];
  return { ok: true, invite, code };
}

function revokeInvite(room, id) {
  const invite = invitesOf(room).find((i) => i.id === id);
  if (!invite) return { ok: false, error: "not_found" };
  invite.revokedAt = Date.now();
  return { ok: true, invite };
}

/** Safe to send to a client: never includes the code or its hash. */
function inviteView(room) {
  return invitesOf(room).map((i) => ({
    id: i.id,
    login: i.login,
    state: inviteState(i),
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    invitedBy: i.invitedBy,
    acceptedAt: i.acceptedAt,
  }));
}

function pendingInviteFor(room, login) {
  const claimed = normLogin(login);
  return invitesOf(room).find((i) => normLogin(i.login) === claimed && inviteState(i) === "pending") || null;
}

function acceptedInviteFor(room, login) {
  const claimed = normLogin(login);
  return invitesOf(room).find((i) => normLogin(i.login) === claimed && inviteState(i) === "accepted") || null;
}

/**
 * Checks an invite code against the room. `login` is who is claiming it — an
 * invite addressed to one person must not be usable by another, otherwise a
 * forwarded link is as good as an open door. A code-less redeem is only safe
 * after GitHub identity proof (see /api/room/redeem).
 */
function redeemInvite(room, code, login) {
  const claimed = normLogin(login);
  if (!claimed) return { ok: false, reason: "login_required" };
  if (code) {
    const hashed = hash(code);
    const invite = invitesOf(room).find((i) => sameSecret(i.codeHash, hashed));
    if (!invite) return { ok: false, reason: "invite_invalid" };
    const state = inviteState(invite);
    if (state === "revoked") return { ok: false, reason: "invite_revoked" };
    if (state === "expired") return { ok: false, reason: "invite_expired" };
    if (state === "accepted") return { ok: false, reason: "invite_already_used" };
    if (normLogin(invite.login) !== claimed) {
      return { ok: false, reason: "invite_wrong_user", invitedLogin: invite.login };
    }
    return { ok: true, invite };
  }
  // Code-less redeem is only safe after GitHub identity proof (see /api/room/redeem).
  const pending = pendingInviteFor(room, claimed);
  if (pending) return { ok: true, invite: pending };
  const accepted = acceptedInviteFor(room, claimed);
  if (accepted) return { ok: true, invite: accepted, rejoin: true };
  return { ok: false, reason: "invite_required" };
}

function markAccepted(invite, login) {
  invite.acceptedAt = Date.now();
  invite.acceptedBy = normLogin(login);
  return invite;
}

/** Mints the long-lived credential a member presents on every later request. */
function issueMemberToken(room, login) {
  const target = normLogin(login);
  const token = mint("rlm");
  room.memberTokens = (Array.isArray(room.memberTokens) ? room.memberTokens : []).filter(
    (t) => normLogin(t.login) !== target
  );
  room.memberTokens.push({ login: target, tokenHash: hash(token), issuedAt: Date.now() });
  return token;
}

function authorizeMember(room, token) {
  if (!token) return null;
  const hashed = hash(token);
  const row = (Array.isArray(room?.memberTokens) ? room.memberTokens : []).find((t) =>
    sameSecret(t.tokenHash, hashed)
  );
  return row ? { login: row.login, issuedAt: row.issuedAt } : null;
}

function revokeMember(room, login) {
  const target = normLogin(login);
  room.memberTokens = (Array.isArray(room.memberTokens) ? room.memberTokens : []).filter(
    (t) => normLogin(t.login) !== target
  );
  room.invites = invitesOf(room).map((i) =>
    normLogin(i.login) === target && !i.revokedAt ? { ...i, revokedAt: Date.now() } : i
  );
  return room;
}

/**
 * The room as it is safe to hand to any client. /api/health and /api/room are
 * both reachable through the tunnel without credentials, and the raw room
 * carries invite and member token hashes.
 */
function publicRoom(room) {
  if (!room) return null;
  const { invites, memberTokens, members, memberToken, nonce, ...rest } = room;
  return { ...rest, memberCount: Array.isArray(members) ? members.length : 0 };
}

/** Reads the member credential off a request. */
function roomToken(req) {
  const header = req.headers?.["x-relay-room-token"];
  if (header) return String(header);
  const auth = String(req.headers?.authorization || "");
  if (/^Room\s+/i.test(auth)) return auth.replace(/^Room\s+/i, "").trim();
  return req.query?.token ? String(req.query.token) : null;
}

/**
 * True when the request arrived from somewhere other than this machine. ngrok
 * (and any reverse proxy) stamps X-Forwarded-For, which a remote caller cannot
 * strip. Local Mission Control and local hooks stay unauthenticated so adding
 * room security never breaks solo use.
 */
function isRemoteRequest(req) {
  if (req.headers?.["x-forwarded-for"] || req.headers?.["x-original-forwarded-for"]) return true;
  const addr = String(req.socket?.remoteAddress || req.connection?.remoteAddress || "");
  if (!addr) return false;
  const bare = addr.replace(/^::ffff:/, "");
  return bare !== "127.0.0.1" && bare !== "::1" && bare !== "localhost";
}

module.exports = {
  INVITE_TTL_MS,
  hash,
  normLogin,
  createInvite,
  revokeInvite,
  inviteView,
  inviteState,
  invitesOf,
  redeemInvite,
  pendingInviteFor,
  markAccepted,
  issueMemberToken,
  authorizeMember,
  revokeMember,
  publicRoom,
  roomToken,
  isRemoteRequest,
};
