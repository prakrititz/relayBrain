'use client';

import React, { useMemo, useState } from 'react';
import { useRelay } from '@/lib/RelayContext';
import { AGENT_BY_ID, filterTimeline } from '@/lib/relay';
import ActivityTimeline from './ActivityTimeline';
import AgentSessionChat from './AgentSessionChat';
import styles from './ProjectDashboard.module.css';

const IR_TABS = [
  { key: 'project', label: 'Project' },
  { key: 'currentTask', label: 'Tasks' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'failures', label: 'Failures' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'compileBrief', label: 'Compile brief' },
] as const;

type IrKey = (typeof IR_TABS)[number]['key'];

function EditCard({ e }: { e: ReturnType<typeof filterTimeline>[0] }) {
  const meta = AGENT_BY_ID[e.source as keyof typeof AGENT_BY_ID];
  return (
    <details className={styles.editCard}>
      <summary className={styles.editSummary}>
        {meta && <img src={meta.logo} alt="" className={styles.editLogo} />}
        <span className={styles.editFile}>{e.file || e.path || 'Edit'}</span>
        <span className={styles.editTime}>{e.ts ? new Date(e.ts).toLocaleString() : ''}</span>
      </summary>
      {e.summary && <div className={styles.editMeta}>{e.summary}</div>}
      {e.diff && (
        <pre className={`mono ${styles.diff}`}>
          {e.diff.split('\n').slice(0, 80).join('\n')}
          {e.diff.split('\n').length > 80 ? '\n…' : ''}
        </pre>
      )}
    </details>
  );
}

export default function ProjectDashboard() {
  const { activeWorkspace, activeProject, memory, dashboard, syncing, refresh } = useRelay();
  const [tab, setTab] = useState<'activity' | 'chat' | 'edits' | 'memory' | 'settings'>('activity');
  const [irTab, setIrTab] = useState<IrKey>('project');

  const timeline = memory?.timeline || [];
  const edits = useMemo(
    () =>
      filterTimeline(dashboard?.recentEdits?.length ? dashboard.recentEdits : timeline).filter(
        (e) => e.kind === 'code_edit' || e.kind === 'artifact',
      ),
    [dashboard, timeline],
  );

  const irContent = dashboard?.ir?.[irTab] || '';
  const handoff = dashboard?.handoff?.markdown || '';

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.tabs}>
          {(
            [
              ['activity', 'Activity'],
              ['chat', 'Agent chat'],
              ['memory', 'All IR files'],
              ['edits', 'Code edits'],
              ['settings', 'Settings'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`${styles.tab} ${tab === key ? styles.tabActive : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.syncBtn}
          disabled={syncing || !activeWorkspace}
          onClick={() => refresh({ full: true })}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      <div className={styles.body}>
        {!activeWorkspace ? (
          <div className={styles.empty}>Select or add a workspace to view project memory.</div>
        ) : tab === 'activity' ? (
          <ActivityTimeline
            events={timeline}
            emptyMessage="Connect an agent from the sidebar to populate the timeline."
          />
        ) : tab === 'chat' ? (
          <AgentSessionChat />
        ) : tab === 'edits' ? (
          <div className={`${styles.editsList} custom-scrollbar`}>
            {edits.length === 0 ? (
              <div className={styles.empty}>No code edits recorded yet.</div>
            ) : (
              edits.map((e, i) => <EditCard key={`${e.ts}-${i}`} e={e} />)
            )}
          </div>
        ) : tab === 'memory' ? (
          <div className={styles.memoryLayout}>
            <div className={styles.irTabs}>
              {IR_TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`${styles.irTab} ${irTab === t.key ? styles.irTabActive : ''}`}
                  onClick={() => setIrTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className={styles.memoryGrid}>
              <article className={styles.memoryCard}>
                <div className={styles.cardTitle}>Handoff</div>
                <pre className={`${styles.md} custom-scrollbar`}>{handoff || 'No handoff yet — run /relay update in an agent.'}</pre>
              </article>
              <article className={styles.memoryCard}>
                <div className={styles.cardTitle}>{IR_TABS.find((t) => t.key === irTab)?.label}</div>
                <pre className={`${styles.md} custom-scrollbar`}>{irContent || 'No content yet.'}</pre>
              </article>
            </div>
          </div>
        ) : (
          <div className={styles.settings}>
            <article className={styles.settingsCard}>
              <div className={styles.cardTitle}>Project</div>
              <p className={styles.settingsRow}>
                <span>Name</span>
                <strong>{activeProject?.name || activeWorkspace.full}</strong>
              </p>
              <p className={styles.settingsRow}>
                <span>Path</span>
                <code className="mono">{activeWorkspace.localPath}</code>
              </p>
            </article>
            <article className={styles.settingsCard}>
              <div className={styles.cardTitle}>API key</div>
              <p className={styles.hint}>For MCP and remote agents. Copy from relay init output or project registry.</p>
              <code className={`mono ${styles.apiKey}`}>
                {activeProject?.apiKey || 'Open Settings after relay init registers this project.'}
              </code>
            </article>
            <article className={styles.settingsCard}>
              <div className={styles.cardTitle}>Stats</div>
              <p className={styles.settingsRow}>
                <span>Events</span>
                <strong>{dashboard?.stats?.totalEvents ?? timeline.length}</strong>
              </p>
              <p className={styles.settingsRow}>
                <span>Connected agents</span>
                <strong>{dashboard?.stats?.connectedAgents ?? 0}</strong>
              </p>
              <p className={styles.settingsRow}>
                <span>Last sync</span>
                <strong>{dashboard?.lastSync ? new Date(dashboard.lastSync).toLocaleString() : '—'}</strong>
              </p>
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
