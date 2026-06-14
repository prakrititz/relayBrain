'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelay } from '@/lib/RelayContext';
import styles from './GlobalHeader.module.css';

export default function GlobalHeader() {
  const router = useRouter();
  const { workspaces, activeWorkspace, selectWorkspace, agentStates, relayOnline, dashboard, memory, syncing, refresh } = useRelay();
  const [open, setOpen] = useState(false);

  const connectedCount = agentStates.filter((a) => a.status === 'connected').length;
  const eventCount = dashboard?.stats?.totalEvents ?? memory?.timeline?.length ?? 0;

  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>
          <img src="/logos/logo.png" alt="" style={{ height: 36, objectFit: 'contain' }} />
          /.relay
        </div>

        <div style={{ position: 'relative' }}>
          <div className={styles.projectDropdown} onClick={() => setOpen((o) => !o)}>
            {activeWorkspace ? activeWorkspace.full : 'No workspace'}
            <span className={styles.arrow}>▼</span>
          </div>
          {open && (
            <div className={styles.dropdownMenu}>
              {workspaces.map((w) => (
                <div
                  key={w.id}
                  className={styles.dropdownItem}
                  data-active={w.active || undefined}
                  onClick={() => {
                    selectWorkspace(w.id);
                    setOpen(false);
                  }}
                >
                  {w.full}
                </div>
              ))}
              <div
                className={styles.dropdownAdd}
                onClick={() => {
                  setOpen(false);
                  router.push('/onboarding');
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
        <button
          type="button"
          className={styles.syncBtn}
          disabled={syncing || !activeWorkspace}
          onClick={() => refresh({ full: true })}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <div className={styles.statusPill}>
          <span className={styles.statusDot} data-live={relayOnline || undefined} />
          {relayOnline ? 'Relay online' : 'Relay offline'}
        </div>
      </div>
    </header>
  );
}
