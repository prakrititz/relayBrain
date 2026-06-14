'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelay } from '@/lib/RelayContext';
import { badgeFromName } from '@/lib/workspaces';
import DirectoryPicker from '@/components/DirectoryPicker';
import styles from './page.module.css';

export default function Onboarding() {
  const router = useRouter();
  const { registerAndAdd, relayOnline } = useRelay();
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function register(localPath: string, full: string) {
    setBusy(true);
    setError(null);
    setStatusText('Registering workspace on relay…');
    try {
      await registerAndAdd({
        id: `local-${Date.now()}`,
        name: badgeFromName(full),
        full,
        source: 'local',
        localPath,
      });
      router.push('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to register workspace');
      setBusy(false);
      setStatusText(null);
    }
  }

  function handleLocalPick(absPath: string) {
    const leaf = absPath.split(/[/\\]/).filter(Boolean).pop() || absPath;
    register(absPath, leaf);
  }

  return (
    <div className={styles.container}>
      <div className={`glass-panel ${styles.card}`}>
        <div>
          <h1 className={styles.title}>Add Workspace</h1>
          <p className={styles.subtitle}>
            Pick a local project folder where your coding agents run. Relay will track
            shared memory across Cursor, Claude, Copilot, Codex, and Antigravity.
          </p>
        </div>

        {!relayOnline && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-secondary)',
              fontSize: 12,
            }}
          >
            Relay backend is offline. Start it with <span className="mono">relay serve</span>{' '}
            — registration needs the API running.
          </div>
        )}

        {error && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid rgba(255,120,120,0.5)',
              color: '#ff9a9a',
              fontSize: 12,
              wordBreak: 'break-word',
            }}
          >
            {error}
          </div>
        )}

        {busy && statusText && (
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {statusText}
          </div>
        )}

        <DirectoryPicker onPick={handleLocalPick} busy={busy} />

        <button className={styles.skipBtn} onClick={() => router.push('/')}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
