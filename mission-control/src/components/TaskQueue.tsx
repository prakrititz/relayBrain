'use client';

import React from 'react';
import styles from './TaskQueue.module.css';

export default function TaskQueue() {
  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">
        PENDING VOTES <span className={styles.count}>[3 open]</span>
      </div>

      <div className={styles.queueContainer}>
        
        <div className={styles.taskCard}>
          <div className={styles.taskTitle}>#48 Use tRPC instead of REST</div>
          <div className={styles.taskMeta}>Proposed by Arjun via Codex • 2m ago</div>
          <div className={styles.taskMsg}>"Better type safety end-to-end"</div>
          <div className={styles.voteStats}>Y: 1 N: 0 Views: 2</div>
          <div className={styles.voteActions}>
            <button className={styles.btnYes}>Agree</button>
            <button className={styles.btnNo}>Disagree</button>
            <button className={styles.btnMsg}>Comment</button>
          </div>
        </div>

        <div className={styles.taskCard}>
          <div className={styles.taskTitle}>#47 Increase rate limit to 200 req/min</div>
          <div className={styles.taskMeta}>Proposed by Unnath via Copilot • 14m ago</div>
          <div className={styles.voteStats}>Y: 2 N: 1 — closes in 2h</div>
          <div className={styles.voteActions}>
            <button className={styles.btnYes}>Agree</button>
            <button className={styles.btnNo}>Disagree</button>
            <button className={styles.btnMsg}>Comment</button>
          </div>
        </div>

      </div>
    </div>
  );
}
