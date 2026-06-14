'use client';

// Browses the local filesystem via /api/fs and lets the user pick a folder's
// absolute path for the Add Workspace flow.

import React, { useCallback, useEffect, useState } from 'react';

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FsResponse {
  path: string | null;
  parent: string | null;
  entries: Entry[];
  error?: string;
}

export default function DirectoryPicker({
  onPick,
  busy = false,
  pickLabel = 'Use this folder',
}: {
  onPick: (absolutePath: string) => void;
  busy?: boolean;
  pickLabel?: string;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const navigate = useCallback(async (target: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const url = target ? `/api/fs?path=${encodeURIComponent(target)}` : '/api/fs';
      const res = await fetch(url);
      const data: FsResponse = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to read folder');
      setCurrent(data.path);
      setParent(data.parent);
      setEntries(data.entries.filter((e) => e.isDir));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to read folder');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    navigate(null);
  }, [navigate]);

  const box: React.CSSProperties = {
    background: 'var(--color-surface-3)',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={() => navigate(parent)}
          disabled={loading || (current === null)}
          style={{
            ...box,
            padding: '6px 10px',
            color: 'var(--text-secondary)',
            cursor: current === null ? 'not-allowed' : 'pointer',
            fontSize: 13,
            opacity: current === null ? 0.4 : 1,
          }}
        >
          ↑ Up
        </button>
        <div
          className="mono"
          style={{
            flex: 1,
            ...box,
            padding: '6px 10px',
            fontSize: 12,
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current || 'This PC'}
        </div>
      </div>

      <div
        className="custom-scrollbar"
        style={{ ...box, maxHeight: 220, overflowY: 'auto', minHeight: 120 }}
      >
        {loading ? (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>{error}</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>
            No sub-folders here. Use the button below to select this folder.
          </div>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => navigate(e.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--color-border)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontSize: 13,
                textAlign: 'left',
              }}
            >
              <span style={{ opacity: 0.6 }}>📁</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {e.name}
              </span>
            </button>
          ))
        )}
      </div>

      <button
        type="button"
        disabled={!current || busy}
        onClick={() => current && onPick(current)}
        style={{
          background: 'var(--color-active)',
          color: '#000',
          border: 'none',
          borderRadius: 6,
          padding: '10px 16px',
          fontSize: 13,
          fontWeight: 700,
          cursor: !current || busy ? 'not-allowed' : 'pointer',
          opacity: !current || busy ? 0.4 : 1,
        }}
      >
        {busy ? 'Working…' : `${pickLabel}${current ? '' : ''}`}
      </button>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="mono"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="…or paste an absolute path"
          style={{
            flex: 1,
            ...box,
            padding: '8px 10px',
            color: 'var(--text-primary)',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          type="button"
          disabled={!manual.trim() || busy}
          onClick={() => onPick(manual.trim())}
          style={{
            ...box,
            padding: '8px 14px',
            color: 'var(--text-secondary)',
            cursor: !manual.trim() || busy ? 'not-allowed' : 'pointer',
            fontSize: 13,
            opacity: !manual.trim() || busy ? 0.4 : 1,
          }}
        >
          Use
        </button>
      </div>
    </div>
  );
}
