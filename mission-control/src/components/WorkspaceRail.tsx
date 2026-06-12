'use client';

import React, { useState } from 'react';
import styles from './WorkspaceRail.module.css';

const workspaces = [
  { id: 'gg', name: 'GG', full: 'GoalGuard', active: true },
  { id: 'os', name: 'OS', full: 'OrbitOS', active: false },
  { id: 'dt', name: 'DT', full: 'DataTool', active: false },
];

export default function WorkspaceRail() {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <nav 
      className={`${styles.rail} ${isExpanded ? styles.expanded : ''}`}
      onMouseEnter={() => setIsExpanded(true)}
      onMouseLeave={() => setIsExpanded(false)}
    >
      <div className={styles.topSection}>
        {isExpanded && <div className={styles.sectionTitle}>WORKSPACES</div>}
        {workspaces.map(ws => (
          <div key={ws.id} className={`${styles.itemWrapper} ${ws.active ? styles.activeWrapper : ''}`}>
            <div className={`${styles.workspaceIcon} ${ws.active ? styles.active : ''}`}>
              {ws.name}
            </div>
            {isExpanded && <span className={styles.itemText}>{ws.full}</span>}
          </div>
        ))}
        
        <div className={styles.itemWrapper}>
          <div className={styles.addWorkspace}>+</div>
          {isExpanded && <span className={styles.itemText}>Add Workspace</span>}
        </div>

        <div className={styles.separator}></div>

        {isExpanded && <div className={styles.sectionTitle}>KNOWLEDGE</div>}
        <div className={styles.itemWrapper}>
          <div className={styles.allMemoriesIcon}>M</div>
          {isExpanded && <span className={styles.itemText}>All Memories</span>}
        </div>
      </div>

      <div className={styles.bottomSection}>
        <div className={styles.itemWrapper}>
          <div className={styles.actionIcon}>≡</div>
          {isExpanded && <span className={styles.itemText}>Settings</span>}
        </div>
        <div className={styles.itemWrapper}>
          <div className={styles.profileAvatar}>P</div>
          {isExpanded && <span className={styles.itemText}>Profile</span>}
        </div>
      </div>
    </nav>
  );
}
