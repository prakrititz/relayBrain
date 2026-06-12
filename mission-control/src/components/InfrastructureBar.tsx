'use client';

import React from 'react';
import styles from './InfrastructureBar.module.css';

const tools = [
  { name: 'Claude Code', user: 'Pony', status: 'ok' },
  { name: 'Copilot', user: 'Unnath', status: 'ok' },
  { name: 'Codex', user: 'Arjun', status: 'ok' },
  { name: 'Cursor', user: '—', status: 'idle' },
];

export default function InfrastructureBar() {
  return (
    <div className={styles.bar}>
      <div className={styles.left}>
        <span className={styles.label}>CONNECTED TOOLS</span>
        <div className={styles.containerList}>
          {tools.map(t => (
            <div key={t.name} className={styles.containerPill}>
              <span className={styles[t.status]}>●</span> {t.name} <span className={styles.toolUser}>{t.user}</span>
            </div>
          ))}
          <button className={styles.connectBtn}>+ Connect Your Tool</button>
        </div>
      </div>
      
      <div className={styles.metrics}>
        <span className={styles.sysOk}>Mesh Node Online</span>
      </div>
    </div>
  );
}
