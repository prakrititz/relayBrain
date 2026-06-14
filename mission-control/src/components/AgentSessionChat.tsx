'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRelay } from '@/lib/RelayContext';
import { AGENTS, AgentId, getMissionMeta, MissionChatMessage, saveMissionMeta } from '@/lib/relay';
import styles from './AgentSessionChat.module.css';

const LAUNCH_HINTS: Record<AgentId, string> = {
  Cursor:
    'Open this folder in Cursor. In Agent chat, type `/relay context` to load handoff. Relay cannot run Cursor from the browser.',
  'Claude Code':
    'In a terminal: `cd` to your project, run `claude`, then `/relay context`. Relay does not embed Claude Code here.',
  'GitHub Copilot':
    'Open the folder in VS Code / Copilot, or run the Copilot CLI in this directory. Type `/relay context` in session.',
  Codex:
    'In a terminal: `cd` to your project, run `codex`, then `/relay context`. Relay does not embed Codex here.',
  Antigravity:
    'Open this folder in Antigravity IDE. Relay cannot run Antigravity agents from the browser.',
};

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AgentSessionChat() {
  const { activeWorkspace, relayOnline } = useRelay();
  const [messages, setMessages] = useState<MissionChatMessage[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [author, setAuthor] = useState('You');
  const [agent, setAgent] = useState<AgentId>('Cursor');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!activeWorkspace?.localPath || !relayOnline) return;
    try {
      const { meta } = await getMissionMeta(activeWorkspace.localPath);
      setMessages(meta.chat || []);
      setCollaborators(meta.collaborators || []);
      if (meta.collaborators?.length) setAuthor(meta.collaborators[0]);
    } catch {
      /* ignore */
    }
  }, [activeWorkspace?.localPath, relayOnline]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function persistChat(next: MissionChatMessage[]) {
    if (!activeWorkspace?.localPath) return;
    setSaving(true);
    try {
      await saveMissionMeta(activeWorkspace.localPath, { chat: next });
      setMessages(next);
    } finally {
      setSaving(false);
    }
  }

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || !activeWorkspace) return;

    const userMsg: MissionChatMessage = {
      id: newId(),
      author,
      agent,
      role: 'user',
      text: trimmed,
      ts: new Date().toISOString(),
    };

    const systemMsg: MissionChatMessage = {
      id: newId(),
      author: 'Relay',
      agent,
      role: 'system',
      text: LAUNCH_HINTS[agent],
      ts: new Date().toISOString(),
    };

    const next = [...messages, userMsg, systemMsg];
    setText('');
    await persistChat(next);
  }

  const authorOptions = collaborators.length ? collaborators : ['You'];

  return (
    <div className={styles.root}>
      <div className={styles.banner}>
        <strong>Team notes + agent routing.</strong> Relay syncs memory — it does not run IDE agents in the browser.
        Open your chosen tool locally; use this chat to coordinate and pick who uses which agent.
      </div>

      <div className={styles.agentRow}>
        {AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`${styles.agentChip} ${agent === a.id ? styles.agentChipActive : ''}`}
            onClick={() => setAgent(a.id)}
            title={a.desc}
          >
            <img src={a.logo} alt="" className={styles.agentLogo} />
            {a.label}
          </button>
        ))}
      </div>

      <div className={styles.metaRow}>
        <label className={styles.metaLabel}>
          Posting as
          <select className={styles.select} value={author} onChange={(e) => setAuthor(e.target.value)}>
            {authorOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className={styles.metaHint}>Target agent: {agent}</span>
        {saving && <span className={styles.metaHint}>Saving…</span>}
      </div>

      <div className={`${styles.messages} custom-scrollbar`}>
        {!activeWorkspace ? (
          <div className={styles.empty}>Select a workspace to chat.</div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            Write a note for your team, pick an agent above, and send — Relay will show how to open that agent locally.
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`${styles.msg} ${m.role === 'system' ? styles.msgSystem : ''}`}>
              <div className={styles.msgMeta}>
                <span>{m.author}</span>
                {m.agent && m.role === 'user' && <span className={styles.msgAgent}>→ {m.agent}</span>}
                <span className={styles.msgTime}>
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className={styles.msgText}>{m.text}</div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className={styles.compose}>
        <textarea
          className={styles.input}
          rows={2}
          placeholder={`Message for team (routing to ${agent})…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={!activeWorkspace || !relayOnline}
        />
        <button type="button" className={styles.sendBtn} onClick={send} disabled={!text.trim() || !activeWorkspace}>
          Send
        </button>
      </div>
    </div>
  );
}
