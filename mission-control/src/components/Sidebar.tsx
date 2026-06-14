'use client';

import React from 'react';
import { AGENTS, filterTimeline } from '@/lib/relay';
import { useRelay, AgentStatus } from '@/lib/RelayContext';
import styles from './Sidebar.module.css';

const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Connect',
  handshaking: 'Connecting…',
  connected: 'Connected',
  error: 'Retry',
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: 'var(--text-muted)',
  handshaking: 'var(--color-warning)',
  connected: 'var(--color-success)',
  error: '#ff9a9a',
};

function relativeTime(ts?: string): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Sidebar() {
  const { activeWorkspace, agentStates, connect, memory } = useRelay();
  const stateById = Object.fromEntries(agentStates.map((s) => [s.id, s]));

  const handleConnect = async (id: (typeof AGENTS)[number]['id']) => {
    try {
      await connect(id);
    } catch {
      /* error surfaced via agentStates */
    }
  };

  const recent = filterTimeline(memory?.timeline || []).slice(-8).reverse();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sectionTitle}>AGENT INTEGRATIONS</div>

      {!activeWorkspace && (
        <div style={{ padding: '0 16px 12px', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Select or add a workspace to connect your agents.
        </div>
      )}

      <div className={styles.integrationsList}>
        {AGENTS.map((agent) => {
          const st = stateById[agent.id];
          const status = (st?.status || 'idle') as AgentStatus;
          const connected = status === 'connected';
          const disabled = !activeWorkspace || status === 'handshaking';
          return (
            <div key={agent.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                className={styles.initBtn}
                disabled={disabled}
                onClick={() => handleConnect(agent.id)}
                style={{
                  opacity: disabled && !connected ? 0.55 : 1,
                  borderColor: connected ? 'var(--color-success)' : undefined,
                  background: connected ? 'rgba(34, 208, 122, 0.08)' : undefined,
                }}
              >
                <img
                  src={agent.logo}
                  alt={agent.label}
                  className={styles.btnLogo}
                  style={{ filter: connected ? 'none' : undefined }}
                />
                <span style={{ flex: 1 }}>{agent.label}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: STATUS_COLOR[status] }}>
                  {STATUS_LABEL[status]}
                </span>
              </button>
              {status === 'connected' && (st?.eventCount ?? 0) > 0 && (
                <div style={{ paddingLeft: 4, fontSize: 10, color: 'var(--text-muted)' }}>
                  ✓ {st.eventCount} events loaded
                </div>
              )}
              {status === 'error' && st?.error && (
                <div style={{ paddingLeft: 4, fontSize: 10, color: '#ff9a9a', lineHeight: 1.4 }}>
                  {st.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.spacerSmall} />

      <div className={styles.sectionTitle}>RECENT AGENT ACTIVITY</div>
      <div className={`${styles.proposalsList} custom-scrollbar`} style={{ overflowY: 'auto' }}>
        {recent.length === 0 ? (
          <div style={{ padding: '0 16px', fontSize: 11, color: 'var(--text-muted)' }}>
            {activeWorkspace ? 'No agent events yet. Connect an agent to populate this.' : '—'}
          </div>
        ) : (
          recent.map((e, i) => {
            const icon = e.kind === 'code_edit' ? '✎' : e.kind === 'artifact' ? '◆' : '•';
            const text =
              e.kind === 'code_edit'
                ? e.file || e.summary || 'Edited a file'
                : (e.content || e.summary || '').slice(0, 90);
            return (
              <div key={`${e.ts}-${i}`} className={styles.proposalItem}>
                <div className={styles.proposalIcon}>{icon}</div>
                <div className={styles.proposalContent}>
                  <div className={styles.proposalText}>
                    <strong>{e.source}</strong> {text}
                  </div>
                  <div className={styles.proposalTime}>{relativeTime(e.ts)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className={styles.spacer} />
    </aside>
  );
}
