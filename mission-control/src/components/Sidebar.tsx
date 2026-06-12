'use client';

import React from 'react';
import styles from './Sidebar.module.css';

const teammates = [
  { id: '1', name: 'Pony', tool: 'Claude Code', status: 'CODING', file: '/src/auth/jwt.ts', message: 'working on token refresh', dot: 'green' },
  { id: '2', name: 'Unnath', tool: 'Copilot', status: 'REVIEWING', file: '/api/routes/users.ts', message: '', dot: 'green' },
  { id: '3', name: 'Arjun', tool: 'Codex', status: 'IDLE', file: 'last seen 4m ago', message: '', dot: 'yellow' },
  { id: '4', name: 'Sakshi', tool: 'OFFLINE', status: '', file: '', message: '', dot: 'grey' },
];

const proposals = [
  { id: 'p1', type: 'proposed', icon: '?', text: "Pony's agent proposed #48 JWT auth approach", time: '2m ago' },
  { id: 'p2', type: 'committed', icon: '+', text: "#46 committed to memory Postgres migration", time: '1h ago' },
  { id: 'p3', type: 'rejected', icon: '-', text: "#44 rejected (2-1 vote) Use MongoDB", time: '3h ago' },
  { id: 'p4', type: 'comment', icon: '@', text: 'Unnath commented on #47 "we should test first"', time: '4h ago' },
];

export default function Sidebar() {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.sectionTitle}>TEAMMATES</div>
      
      <div className={styles.teammatesList}>
        {teammates.map(tm => (
          <div key={tm.id} className={styles.teammateCard}>
            <div className={styles.tmHeader}>
              <span className={`${styles.statusDot} ${styles[tm.dot]}`}></span>
              <span className={styles.tmName}>{tm.name}</span>
            </div>
            {tm.tool !== 'OFFLINE' && (
              <div className={styles.tmDetails}>
                <div className={styles.tmTool}>{tm.tool} • {tm.status}</div>
                <div className={styles.tmFile}>{tm.file}</div>
                {tm.message && <div className={styles.tmMsg}>"{tm.message}"</div>}
              </div>
            )}
            {tm.tool === 'OFFLINE' && (
              <div className={styles.tmDetails}>
                <div className={styles.tmTool}>OFFLINE</div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={styles.spacer}></div>

      <div className={styles.sectionTitle}>RECENT MEMORY ACTIVITY</div>
      <div className={styles.proposalsList}>
        {proposals.map(p => (
          <div key={p.id} className={styles.proposalItem}>
            <div className={styles.proposalIcon}>{p.icon}</div>
            <div className={styles.proposalContent}>
              <div className={styles.proposalText}>{p.text}</div>
              <div className={styles.proposalTime}>{p.time}</div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
