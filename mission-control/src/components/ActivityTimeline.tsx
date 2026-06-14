'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_BY_ID, AGENTS, RelayEvent, filterTimeline } from '@/lib/relay';
import styles from './ActivityTimeline.module.css';

export type TimelineSegment = {
  id: string;
  agent: string;
  label: string;
  time: string;
  events: RelayEvent[];
};

function segmentLabel(events: RelayEvent[]): string {
  const userMsg = events.find((e) => e.kind === 'message' && e.role === 'user');
  if (userMsg?.content) return userMsg.content.slice(0, 72).replace(/\s+/g, ' ');
  const edit = events.find((e) => e.kind === 'code_edit' || e.kind === 'artifact');
  if (edit) return edit.file || edit.summary || 'Code edit';
  const msg = events.find((e) => e.content);
  return (msg?.content || 'Activity').slice(0, 72).replace(/\s+/g, ' ');
}

export function buildSegments(events: RelayEvent[]): { agent: string; segments: TimelineSegment[] }[] {
  const filtered = filterTimeline(events);
  const byAgent = new Map<string, RelayEvent[]>();

  for (const e of filtered) {
    const agent = e.source || 'Unknown';
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent)!.push(e);
  }

  const agentOrder = AGENTS.map((a) => a.id);
  const sortedAgents = [...byAgent.keys()].sort(
    (a, b) => (agentOrder.indexOf(a as typeof agentOrder[number]) + 1 || 99) - (agentOrder.indexOf(b as typeof agentOrder[number]) + 1 || 99),
  );

  return sortedAgents.map((agent) => {
    const agentEvents = byAgent.get(agent) || [];
    const segments: TimelineSegment[] = [];
    let current: RelayEvent[] = [];

    for (const e of agentEvents) {
      if (e.kind === 'message' && e.role === 'user' && current.length) {
        segments.push({
          id: `${agent}-${segments.length}`,
          agent,
          label: segmentLabel(current),
          time: current[0]?.ts || '',
          events: current,
        });
        current = [];
      }
      current.push(e);
    }
    if (current.length) {
      segments.push({
        id: `${agent}-${segments.length}`,
        agent,
        label: segmentLabel(current),
        time: current[0]?.ts || '',
        events: current,
      });
    }

    return { agent, segments };
  });
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className={`mono ${styles.diff}`}>
      {diff.split('\n').map((line, i) => {
        const add = line.startsWith('+') && !line.startsWith('+++');
        const del = line.startsWith('-') && !line.startsWith('---');
        return (
          <div key={i} className={add ? styles.diffAdd : del ? styles.diffDel : undefined}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

function EventBlock({ e }: { e: RelayEvent }) {
  const kind = e.kind || 'message';
  const isEdit = kind === 'code_edit' || kind === 'artifact';
  const meta = AGENT_BY_ID[e.source as keyof typeof AGENT_BY_ID];

  if (isEdit) {
    return (
      <div className={styles.editBlock}>
        <div className={styles.editFile}>{e.file || e.path}</div>
        {e.summary && <div className={styles.editSummary}>{e.summary}</div>}
        {e.diff ? <DiffBlock diff={e.diff} /> : null}
      </div>
    );
  }

  const isUser = e.role === 'user';
  return (
    <div className={`${styles.messageBlock} ${isUser ? styles.messageUser : styles.messageAgent}`}>
      <div className={styles.messageRole}>{isUser ? 'You' : meta?.label || e.source || 'Agent'}</div>
      <div className={styles.messageText}>{e.content}</div>
    </div>
  );
}

interface ActivityTimelineProps {
  events: RelayEvent[];
  emptyMessage?: string;
}

export default function ActivityTimeline({ events, emptyMessage }: ActivityTimelineProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const scrollRef = useRef<HTMLDivElement>(null);
  const segmentRefs = useRef<Map<string, HTMLElement>>(new Map());

  const timeline = useMemo(() => filterTimeline(events), [events]);

  const filtered = useMemo(() => {
    if (filter === 'all') return timeline;
    if (filter === 'user' || filter === 'assistant') return timeline.filter((e) => e.role === filter);
    if (filter === 'code_edit') return timeline.filter((e) => e.kind === 'code_edit' || e.kind === 'artifact');
    return timeline.filter((e) => e.source === filter);
  }, [timeline, filter]);

  const grouped = useMemo(() => buildSegments(filtered), [filtered]);
  const flatSegments = useMemo(() => grouped.flatMap((g) => g.segments), [grouped]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !flatSegments.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((en) => en.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target?.id) setActiveId(visible[0].target.id);
      },
      { root, rootMargin: '-20% 0px -55% 0px', threshold: 0 },
    );

    flatSegments.forEach((seg) => {
      const el = segmentRefs.current.get(seg.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [flatSegments]);

  const jumpTo = (id: string) => {
    const el = segmentRefs.current.get(id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveId(id);
  };

  if (!timeline.length) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⬡</div>
        <p>{emptyMessage || 'No activity yet. Connect an agent to populate the timeline.'}</p>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <aside className={`${styles.nav} custom-scrollbar`}>
        {grouped.map(({ agent, segments }) => {
          const meta = AGENT_BY_ID[agent as keyof typeof AGENT_BY_ID];
          return (
            <div key={agent} className={styles.navAgent}>
              <div className={styles.navAgentHead}>
                {meta && <img src={meta.logo} alt="" className={styles.navLogo} />}
                <span>{meta?.label || agent}</span>
                <span className={styles.navCount}>{segments.length}</span>
              </div>
              {segments.map((seg) => (
                <button
                  key={seg.id}
                  type="button"
                  className={`${styles.navItem} ${activeId === seg.id ? styles.navItemActive : ''}`}
                  onClick={() => jumpTo(seg.id)}
                >
                  <span className={styles.navItemLabel}>{seg.label}</span>
                  <span className={styles.navItemTime}>
                    {seg.time ? new Date(seg.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </aside>

      <div className={styles.main}>
        <div className={styles.filters}>
          {[
            ['all', 'All'],
            ['user', 'User'],
            ['assistant', 'Agent'],
            ['code_edit', 'Edits'],
            ...AGENTS.map((a) => [a.id, a.label] as const),
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`${styles.chip} ${filter === key ? styles.chipActive : ''}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div ref={scrollRef} className={`${styles.feed} custom-scrollbar`}>
          {grouped.map(({ agent, segments }) => {
            const meta = AGENT_BY_ID[agent as keyof typeof AGENT_BY_ID];
            return (
              <div key={agent} className={styles.agentSection}>
                <div className={styles.agentHeader}>
                  {meta && <img src={meta.logo} alt="" className={styles.agentLogo} />}
                  <span>{meta?.label || agent}</span>
                  <span className={styles.agentHeaderCount}>{segments.length} threads</span>
                </div>

                {segments.map((seg) => (
                  <section
                    key={seg.id}
                    id={seg.id}
                    ref={(el) => {
                      if (el) segmentRefs.current.set(seg.id, el);
                      else segmentRefs.current.delete(seg.id);
                    }}
                    className={styles.segment}
                  >
                    <div className={styles.segmentHead}>
                      <span className={styles.segmentLabel}>{seg.label}</span>
                      <span className={styles.segmentTime}>
                        {seg.time ? new Date(seg.time).toLocaleString() : ''}
                      </span>
                    </div>
                    <div className={styles.segmentBody}>
                      {seg.events.map((e, i) => (
                        <EventBlock key={`${seg.id}-${i}`} e={e} />
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
