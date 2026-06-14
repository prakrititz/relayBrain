'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRelay } from '@/lib/RelayContext';
import { getMissionMeta, saveMissionMeta } from '@/lib/relay';
import styles from './CollaboratorsPanel.module.css';

export default function CollaboratorsPanel() {
  const { activeWorkspace, relayOnline } = useRelay();
  const [names, setNames] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!activeWorkspace?.localPath || !relayOnline) return;
    try {
      const { meta } = await getMissionMeta(activeWorkspace.localPath);
      setNames(meta.collaborators || []);
    } catch {
      /* keep local state */
    }
  }, [activeWorkspace?.localPath, relayOnline]);

  useEffect(() => {
    load();
  }, [load]);

  async function persist(next: string[]) {
    if (!activeWorkspace?.localPath) return;
    setSaving(true);
    try {
      await saveMissionMeta(activeWorkspace.localPath, { collaborators: next });
      setNames(next);
    } finally {
      setSaving(false);
    }
  }

  function addName() {
    const name = draft.trim();
    if (!name || names.includes(name)) return;
    const next = [...names, name];
    setDraft('');
    persist(next);
  }

  function removeName(name: string) {
    persist(names.filter((n) => n !== name));
  }

  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className="section-title">
        COLLABORATORS {saving && <span className={styles.muted}>saving…</span>}
      </div>
      <p className={styles.hint}>Team members on this project (stored in `.relay/mission_control.json`).</p>

      {!activeWorkspace ? (
        <p className={styles.hint}>Select a workspace first.</p>
      ) : (
        <>
          <div className={styles.addRow}>
            <input
              className={styles.input}
              placeholder="Name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addName()}
            />
            <button type="button" className={styles.addBtn} onClick={addName} disabled={!draft.trim()}>
              Add
            </button>
          </div>
          <ul className={styles.list}>
            {names.length === 0 ? (
              <li className={styles.empty}>No collaborators yet.</li>
            ) : (
              names.map((name) => (
                <li key={name} className={styles.item}>
                  <span>{name}</span>
                  <button type="button" className={styles.removeBtn} onClick={() => removeName(name)} aria-label={`Remove ${name}`}>
                    ×
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      )}
    </div>
  );
}
