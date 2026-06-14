'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelay } from '@/lib/RelayContext';
import styles from './WorkspaceRail.module.css';

export default function WorkspaceRail() {
  const [isExpanded, setIsExpanded] = useState(false);
  const router = useRouter();
  const { workspaces, selectWorkspace } = useRelay();

  useEffect(() => {
    setIsExpanded(localStorage.getItem('relay_rail_expanded') === '1');
  }, []);

  const toggle = () => {
    setIsExpanded((prev) => {
      const next = !prev;
      localStorage.setItem('relay_rail_expanded', next ? '1' : '0');
      return next;
    });
  };

  return (
    <nav className={`${styles.rail} ${isExpanded ? styles.expanded : ''}`}>
      <div className={styles.topSection}>
        <div className={styles.itemWrapper} onClick={toggle} title={isExpanded ? 'Collapse' : 'Expand'}>
          <div className={styles.actionIcon}>{isExpanded ? '«' : '☰'}</div>
          {isExpanded && <span className={styles.itemText}>Collapse</span>}
        </div>

        {isExpanded && <div className={styles.sectionTitle}>WORKSPACES</div>}

        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className={`${styles.itemWrapper} ${ws.active ? styles.activeWrapper : ''}`}
            onClick={() => selectWorkspace(ws.id)}
            title={ws.localPath}
          >
            <div className={`${styles.workspaceIcon} ${ws.active ? styles.active : ''}`}>
              {ws.name}
            </div>
            {isExpanded && <span className={styles.itemText}>{ws.full}</span>}
          </div>
        ))}

        <div className={styles.itemWrapper} onClick={() => router.push('/onboarding')}>
          <div className={styles.addWorkspace}>+</div>
          {isExpanded && <span className={styles.itemText}>Add Workspace</span>}
        </div>
      </div>
    </nav>
  );
}
