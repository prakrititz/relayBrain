'use client';

import React, { useState } from 'react';
import styles from './ContextMemory.module.css';

const memoryTree = [
  {
    name: 'project',
    isOpen: true,
    children: [
      { name: 'preferred_stack', value: 'NextJS + Postgres' },
      { name: 'environment', value: 'production' },
      { name: 'deploy_strategy', value: 'blue-green' },
      { name: 'last_deploy', value: '14:04:12' }
    ]
  },
  {
    name: 'constraints',
    isOpen: true,
    children: [
      { name: 'no_vendor_lock_in', value: 'true' },
      { name: 'max_latency_p99', value: '200ms' }
    ]
  },
  {
    name: 'user_prefs',
    isOpen: false,
    children: [
      { name: 'code_style', value: 'functional' },
      { name: 'test_coverage', value: '80%' }
    ]
  }
];

export default function ContextMemory() {
  const [tree, setTree] = useState(memoryTree);

  const toggleNode = (index: number) => {
    const newTree = [...tree];
    newTree[index].isOpen = !newTree[index].isOpen;
    setTree(newTree);
  };

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">SHARED MEMORY BANK <span className={styles.count}>[847 entries]</span></div>
      
      <div className={`${styles.treeContainer} mono custom-scrollbar`}>
        <div className={styles.treeRoot}>/</div>
        {tree.map((node, i) => (
          <div key={node.name} className={styles.treeNode}>
            <div className={styles.nodeHeader} onClick={() => toggleNode(i)}>
              <span className={styles.icon}>{node.isOpen ? '-' : '+'}</span>
              <span className={styles.nodeName}>{node.name}</span>
            </div>
            {node.isOpen && (
              <div className={styles.nodeChildren}>
                {node.children.map(child => (
                  <div key={child.name} className={styles.childNode}>
                    <span className={styles.childKey}>{child.name}:</span>
                    <span className={styles.childValue}>{child.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        
        <div className={styles.treeRoot} style={{ marginTop: '16px' }}>/open_questions</div>
        <div className={styles.treeNode}>
          <div className={styles.nodeHeader}>
            <span className={styles.icon}>-</span>
            <span className={styles.nodeName}>should we use tRPC or REST?</span>
          </div>
          <div className={styles.nodeChildren}>
            <div className={styles.childNode}>
              <span className={styles.childKey}>status:</span>
              <span className={styles.childValue}>UNRESOLVED ⚠️</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
