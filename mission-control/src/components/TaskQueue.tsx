'use client';

import React from 'react';
import { useRelay } from '@/lib/RelayContext';
import { RelayTask } from '@/lib/relay';
import styles from './TaskQueue.module.css';

export default function TaskQueue() {
  const { memory } = useRelay();

  const tasks: RelayTask[] = Object.entries(memory?.agents || {}).flatMap(([source, a]) =>
    (a?.tasks || []).map((t) => ({ ...t, source })),
  );

  return (
    <div className={`glass-panel ${styles.panel}`} style={{ padding: 16 }}>
      <div className="section-title">
        AGENT TASKS <span className={styles.count}>[{tasks.length}]</span>
      </div>

      <div className={`${styles.queueContainer} custom-scrollbar`}>
        {tasks.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            No background tasks reported by connected agents.
          </div>
        ) : (
          tasks.map((t, i) => (
            <div key={`${t.id}-${i}`} className={styles.taskCard}>
              <div className={styles.taskTitle} style={{ paddingRight: 0 }}>
                {t.id}
              </div>
              <div className={styles.taskMeta}>{t.source}</div>
              <div
                className="mono"
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: 80,
                  overflow: 'hidden',
                }}
              >
                {(t.preview || '').trim()}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
