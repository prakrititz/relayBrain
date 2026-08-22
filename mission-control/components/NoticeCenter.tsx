"use client";

import { useEffect, useRef, useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import type { Notice } from "@/lib/types";
import ui from "@/styles/ui.module.css";

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 8) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function joinPayload(n: Notice) {
  return {
    url: n.payload?.url,
    hostLogin: n.payload?.hostLogin,
    roomId: n.payload?.roomId,
    gistId: n.payload?.gistId,
  };
}

export function NoticeBell() {
  const { notices, unreadNotices, markNoticeRead, markAllNoticesRead, dismissNotice, joinRoom } = useRelay();
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState("");
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

  useEffect(() => {
    if (open && typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => undefined);
    }
  }, [open]);

  async function join(n: Notice) {
    if (n.action !== "join") return;
    setJoining(n.id);
    try {
      await joinRoom(joinPayload(n));
      setOpen(false);
    } finally {
      setJoining("");
    }
  }

  return (
    <div className={ui.noticeBellWrap} ref={wrapRef}>
      <button
        type="button"
        className={ui.noticeBellBtn}
        onClick={() => setOpen((v) => !v)}
        title={unreadNotices ? `${unreadNotices} unread` : "Notifications"}
        aria-label={unreadNotices ? `${unreadNotices} unread notifications` : "Notifications"}
      >
        <span aria-hidden>🔔</span>
        {unreadNotices ? <span className={ui.noticeDot} /> : null}
      </button>
      {open && (
        <div className={ui.noticeMenu}>
          <div className={ui.noticeMenuHead}>
            <strong>Notifications</strong>
            {notices.length ? (
              <button type="button" className={`${ui.chip} ${ui.ghost}`} onClick={() => markAllNoticesRead()}>
                Mark all read
              </button>
            ) : null}
          </div>
          {notices.length === 0 ? (
            <p className={ui.noticeEmpty}>No notifications yet.</p>
          ) : (
            notices.map((n) => (
              <div
                key={n.id}
                className={`${ui.noticeItem} ${n.readAt ? "" : ui.noticeUnread}`}
                onClick={() => {
                  if (!n.readAt) markNoticeRead(n.id);
                }}
              >
                <div className={ui.noticeItemText}>
                  <strong>{n.title}</strong>
                  {n.body ? <span>{n.body}</span> : null}
                  <em>{ago(n.ts)}</em>
                </div>
                <div className={ui.noticeItemActions}>
                  {n.action === "join" ? (
                    <button
                      type="button"
                      className={ui.syncBtn}
                      disabled={joining === n.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        join(n);
                      }}
                    >
                      {joining === n.id ? "Joining…" : "Join"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${ui.chip} ${ui.ghost}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissNotice({ id: n.id });
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function NoticeToasts() {
  const { toasts, dismissToast, dismissNotice, joinRoom } = useRelay();
  const [joining, setJoining] = useState("");

  useEffect(() => {
    const timers = toasts
      .filter((n) => n.action !== "join")
      .map((n) => window.setTimeout(() => dismissToast(n.id), 8000));
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [toasts, dismissToast]);

  if (!toasts.length) return null;

  async function join(n: Notice) {
    setJoining(n.id);
    try {
      await joinRoom(joinPayload(n));
    } finally {
      setJoining("");
    }
  }

  return (
    <div className={ui.noticeToasts}>
      {toasts.map((n) => (
        <div key={n.id} className={ui.noticeToast}>
          <strong>{n.title}</strong>
          {n.body ? <p>{n.body}</p> : null}
          <div className={ui.noticeToastActions}>
            {n.action === "join" ? (
              <button type="button" className={ui.syncBtn} disabled={joining === n.id} onClick={() => join(n)}>
                {joining === n.id ? "Joining…" : "Join"}
              </button>
            ) : null}
            <button
              type="button"
              className={`${ui.chip} ${ui.ghost}`}
              onClick={() => {
                dismissToast(n.id);
                if (n.action === "join") dismissNotice({ id: n.id });
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
