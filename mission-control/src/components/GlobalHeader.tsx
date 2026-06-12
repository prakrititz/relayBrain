'use client';

import React from 'react';
import styles from './GlobalHeader.module.css';

export default function GlobalHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>MESH</div>
        <div className={styles.projectDropdown}>
          GoalGuard <span className={styles.arrow}>▼</span>
        </div>
        <div className={styles.teammatesOnline}>
          <span className={`${styles.avatarMini} ${styles.bgPony}`}>P</span>
          <span className={`${styles.avatarMini} ${styles.bgUnnath}`}>U</span>
          <span className={`${styles.avatarMini} ${styles.bgArjun}`}>A</span>
        </div>
        <button className={styles.inviteBtn}>+ Invite</button>
      </div>

      <div className={styles.right}>
        <div className={styles.stats}>
          <span>Memories: <strong className="mono">847</strong></span>
          <span>Votes: <strong className="mono">3</strong> pending</span>
        </div>
        <button className={styles.settingsBtn}>Settings</button>
      </div>
    </header>
  );
}
