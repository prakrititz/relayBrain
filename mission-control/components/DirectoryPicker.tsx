"use client";

// Browses the local filesystem via /api/fs (a Next.js server route running on
// the same machine as the app) so picking a folder never means
// hand-typing an absolute path.

import { useCallback, useEffect, useState } from "react";
import ui from "@/styles/ui.module.css";

type Entry = { name: string; path: string; isDir: boolean };
type FsResponse = { path: string | null; parent: string | null; entries: Entry[]; error?: string };

export function DirectoryPicker({
  startAt = null,
  onPick,
  onCancel,
  busy = false,
  pickLabel = "Use this folder",
}: {
  startAt?: string | null;
  onPick: (absolutePath: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  pickLabel?: string;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (target: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const url = target ? `/api/fs?path=${encodeURIComponent(target)}` : "/api/fs";
      const res = await fetch(url);
      const data: FsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to read folder");
      setCurrent(data.path);
      setParent(data.parent);
      setEntries(data.entries.filter((e) => e.isDir));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    navigate(startAt);
  }, [navigate, startAt]);

  return (
    <div className={ui.dirPicker}>
      <div className={ui.dirPickerBar}>
        <button
          type="button"
          className={`${ui.chip} ${ui.ghost}`}
          onClick={() => navigate(parent)}
          disabled={loading || current === null}
        >
          ↑ Up
        </button>
        <div className={ui.dirPickerPath}>{current || "This PC"}</div>
      </div>

      <div className={ui.dirPickerList}>
        {loading ? (
          <div className={ui.dirPickerEmpty}>Loading…</div>
        ) : error ? (
          <div className={ui.dirPickerEmpty}>{error}</div>
        ) : entries.length === 0 ? (
          <div className={ui.dirPickerEmpty}>
            No sub-folders here. Use “{pickLabel}” to select this folder itself.
          </div>
        ) : (
          entries.map((e) => (
            <button type="button" key={e.path} className={ui.dirPickerRow} onDoubleClick={() => navigate(e.path)} onClick={() => navigate(e.path)}>
              <span className={ui.dirPickerIcon} style={{ opacity: 0.6 }}>📁</span>
              <span className={ui.dirPickerName}>{e.name}</span>
            </button>
          ))
        )}
      </div>

      <div className={ui.actions}>
        {onCancel && (
          <button type="button" className={`${ui.chip} ${ui.ghost}`} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className={ui.syncBtn}
          disabled={!current || busy}
          onClick={() => current && onPick(current)}
        >
          {busy ? "Working…" : pickLabel}
        </button>
      </div>
    </div>
  );
}
