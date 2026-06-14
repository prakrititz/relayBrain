'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelay } from '@/lib/RelayContext';
import styles from './GlobalHeader.module.css';

export default function GlobalHeader() {
  const router = useRouter();
  const { workspaces, activeWorkspace, selectWorkspace, agentStates, relayOnline } = useRelay();
  const [open, setOpen] = useState(false);

  const connectedCount = agentStates.filter((a) => a.status === 'connected').length;
  const eventCount = agentStates.reduce((sum, a) => sum + (a.eventCount || 0), 0);

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>
          /.
          <img src="/logos/logo.png" alt="r" style={{ height: 16, objectFit: 'contain', margin: '0 2px' }} />
          elay
        </div>

        <div style={{ position: 'relative' }}>
          <div className={styles.projectDropdown} onClick={() => setOpen((o) => !o)}>
            {activeWorkspace ? activeWorkspace.full : 'No workspace'}
            <span className={styles.arrow}>▼</span>
          </div>
          {open && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: 6,
                minWidth: 220,
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                zIndex: 50,
                overflow: 'hidden',
              }}
            >
              {workspaces.map((w) => (
                <div
                  key={w.id}
                  onClick={() => {
                    selectWorkspace(w.id);
                    setOpen(false);
                  }}
                  style={{
                    padding: '8px 12px',
                    fontSize: 13,
                    cursor: 'pointer',
                    color: w.active ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: w.active ? 'rgba(255,255,255,0.06)' : 'transparent',
                  }}
                >
                  {w.full}
                </div>
              ))}
              <div
                onClick={() => {
                  setOpen(false);
                  router.push('/onboarding');
                }}
                style={{
                  padding: '8px 12px',
                  fontSize: 13,
                  cursor: 'pointer',
                  color: 'var(--text-secondary)',
                  borderTop: '1px solid var(--color-border)',
                }}
              >
                + Add workspace
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.right}>
        <div className={styles.stats}>
          <span>
            Events: <strong className="mono">{eventCount}</strong>
          </span>
          <span>
            Agents: <strong className="mono">{connectedCount}</strong> connected
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: relayOnline ? 'var(--color-success)' : 'var(--text-muted)',
              boxShadow: relayOnline ? '0 0 6px var(--color-success)' : 'none',
            }}
          />
          {relayOnline ? 'Relay online' : 'Relay offline'}
        </div>
      </div>
    </header>
  );
}
