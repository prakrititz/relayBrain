'use client';

import React from 'react';
import { useRelay } from '@/lib/RelayContext';
import { RelayArtifact } from '@/lib/relay';
import styles from './ContextMemory.module.css';

function artifactSummary(a: RelayArtifact): string {
  if (a.metadata) {
    try {
      const m = JSON.parse(a.metadata);
      if (m.Summary || m.ArtifactType) return m.Summary || m.ArtifactType;
    } catch {
      /* not JSON */
    }
  }
  return (a.content || '').slice(0, 120);
}

export default function ContextMemory() {
  const { memory } = useRelay();

  const artifacts: RelayArtifact[] = Object.entries(memory?.agents || {}).flatMap(([source, a]) =>
    (a?.artifacts || []).map((art) => ({ ...art, source })),
  );

  return (
    <div className={`glass-panel ${styles.panel}`} style={{ padding: 16 }}>
      <div className="section-title">
        ARTIFACTS <span className={styles.count}>[{artifacts.length}]</span>
      </div>

      <div className={`${styles.treeContainer} custom-scrollbar`}>
        {artifacts.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            No artifacts yet. Antigravity and other agents emit these when connected.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {artifacts.map((a, i) => (
              <div
                key={`${a.name}-${i}`}
                style={{
                  background: 'var(--color-surface-3)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                  padding: 10,
                }}
              >
                <div className="mono" style={{ fontSize: 12, color: 'var(--color-active)', fontWeight: 600 }}>
                  {a.name}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '2px 0 6px' }}>
                  {a.source}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                  {artifactSummary(a)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
