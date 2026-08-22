"use client";

import { useEffect, useRef, useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import { apiUrl } from "@/lib/api";
import { NoticeBell } from "./NoticeCenter";
import ui from "@/styles/ui.module.css";

function fetchedLabel(ts: number | null, now: number) {
  if (!ts) return "Not synced";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 2) return "Synced just now";
  if (s < 60) return `Synced ${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `Synced ${m}m ago`;
  return `Synced ${Math.round(m / 60)}h ago`;
}

// The account menu lives up here now — it used to sit at the bottom of the
// left workspace rail, which is not where anyone looks for their profile.
function AccountMenu() {
  const { user, users, login, logout, setTab } = useRelay();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const others = users.filter((u) => u.id !== user?.id);

  return (
    <div className={ui.navAccount} ref={wrapRef}>
      {user ? (
        <button
          className={ui.navUser}
          onClick={() => setOpen((v) => !v)}
          title={`${user.name || user.login} · @${user.login}`}
          aria-label={`Account: @${user.login}`}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className={ui.navUserAvatar}>
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : user.login?.[0]?.toUpperCase()}
          </span>
        </button>
      ) : (
        <button className={ui.navSignIn} onClick={() => setOpen((v) => !v)}>
          Sign in
        </button>
      )}

      {open && (
        <div className={ui.navMenu}>
          {user && (
            <div className={ui.navMenuHead}>
              {user.avatarUrl && <img src={user.avatarUrl} alt="" />}
              <div className={ui.navMenuHeadText}>
                <strong>{user.name || user.login}</strong>
                <span>@{user.login}</span>
              </div>
            </div>
          )}

          {/* Settings lives here now rather than in the workspace tab strip. */}
          <button
            className={ui.navMenuItem}
            onClick={() => {
              setTab("settings");
              setOpen(false);
            }}
          >
            <span>Settings</span>
          </button>
          <div className={ui.navMenuSep} />

          {others.length ? <div className={ui.navMenuLabel}>Switch account</div> : null}
          {others.map((u) => (
            <button
              key={u.id}
              className={ui.navMenuItem}
              onClick={() => {
                login(u.login);
                setOpen(false);
              }}
            >
              {u.avatarUrl && <img src={u.avatarUrl} alt="" />}
              <span>
                {u.name || u.login}
                <span className={ui.navMenuItemSub}>@{u.login}</span>
              </span>
            </button>
          ))}
          {/* Without this, a machine with one registered user gets a "switch
              account" section with nothing in it. Same entry point the login
              gate offers. */}
          <a className={ui.navMenuItem} href={apiUrl("/api/auth/github")}>
            <span>Add another account ↗</span>
          </a>
          <div className={ui.navMenuSep} />

          <a className={ui.navMenuItem} href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
            <span>GitHub settings ↗</span>
          </a>
          {user && (
            <button
              className={`${ui.navMenuItem} ${ui.navMenuDanger}`}
              onClick={() => {
                logout();
                setOpen(false);
              }}
            >
              <span>Sign out</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function TopNavbar() {
  const { projects, dashboard, selectedProjectId, sync, syncing, lastFetchedAt } = useRelay();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const project = projects.find((p) => p.id === selectedProjectId) || dashboard?.project;
  const fetched = lastFetchedAt || dashboard?.memory?.lastTranscriptSyncAt || project?.lastSyncAt || null;

  return (
    <div className={ui.navbar}>
      <div className={ui.navBrand}>
        <img src="/logo_transparent.png" alt="./relay" className={ui.navBrandLogo} />
        <span className={ui.navBrandText}>
          <span className={ui.navBrandSlash}>./</span>relay
        </span>
      </div>

      <div className={ui.navProject}>
        {project ? (
          <>
            <span className={ui.navProjectDot} style={{ background: project.color || "var(--accent)" }} />
            <span className={ui.navProjectName}>{project.name}</span>
            <span className={ui.navProjectPath}>{project.path}</span>
          </>
        ) : (
          <span className={ui.navProjectPath}>No workspace selected</span>
        )}
      </div>

      <div className={ui.navRight}>
        <span
          className={`${ui.navStatus} ${syncing ? ui.navStatusLive : ""}`}
          title={syncing ? "Syncing…" : fetchedLabel(fetched, now)}
        >
          <span className={ui.navStatusDot} />
          <span className={ui.navStatusText}>{syncing ? "Syncing…" : fetchedLabel(fetched, now)}</span>
        </span>
        <button
          className={`${ui.navSync} ${syncing ? ui.navSyncing : ""}`}
          onClick={sync}
          disabled={syncing || !project}
          title="Sync this workspace"
        >
          <span className={ui.navSyncGlyph} aria-hidden>↻</span>
          <span className={ui.navSyncLabel}>Sync</span>
        </button>
        <NoticeBell />
        <AccountMenu />
      </div>
    </div>
  );
}
