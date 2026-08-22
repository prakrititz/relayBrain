"use client";

import { useMemo, useState } from "react";
import { AgentLogo, UserAvatar, UserTag } from "@/components/Identity";
import { useRelay } from "@/lib/RelayContext";
import { ExpandableMarkdown, MarkdownView, plainPreview } from "@/lib/markdown";
import type { ChatMessage, ChatThread } from "@/lib/types";
import ui from "@/styles/ui.module.css";

// Combined view flattens every session into one stream; a room with a few long
// transcripts is thousands of messages, so only the tail is mounted.
const COMBINED_CAP = 400;

type Item = {
  key: string;
  m: ChatMessage;
  ts: number;
  agent: string;
  login: string;
  mine?: boolean;
};

/** Consecutive messages from the same speaker read as one turn, not N cards. */
type Turn = {
  key: string;
  side: "user" | "agent";
  agent: string;
  login: string;
  mine?: boolean;
  ts: number;
  day: string;
  items: Item[];
};

function timeAgo(ts?: number) {
  if (!ts) return "";
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function clock(ts?: number) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(ts?: number) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  const yesterday = new Date(today.getTime() - 86400000);
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Edits and thinking are asides, not messages: one quiet line that opens. */
function ArtifactRow({ m }: { m: ChatMessage }) {
  const isEdit = m.kind === "code_edit" || m.role === "tool";
  const body = isEdit && m.text && m.text !== m.file ? m.text : isEdit ? "" : m.text;
  return (
    <details className={ui.aside}>
      <summary>
        <span className={ui.asideMark}>{isEdit ? "✎" : "◇"}</span>
        <span className={ui.asideLabel}>{isEdit ? m.file || "Edit" : "Thinking"}</span>
      </summary>
      {body ? (
        <div className={ui.asideBody}>
          <MarkdownView text={body} />
        </div>
      ) : null}
    </details>
  );
}

function MessageBody({ m, side }: { m: ChatMessage; side: "user" | "agent" }) {
  if (m.kind === "thinking" || m.kind === "code_edit" || m.role === "tool") return <ArtifactRow m={m} />;
  if (side === "user") {
    return (
      <div className={ui.userMsg}>
        <ExpandableMarkdown text={m.text} limit={420} />
      </div>
    );
  }
  return (
    <div className={ui.prose}>
      <ExpandableMarkdown text={m.text} limit={900} />
    </div>
  );
}

function TurnBlock({ turn }: { turn: Turn }) {
  const isUser = turn.side === "user";
  return (
    <div className={`${ui.turn} ${isUser ? ui.turnUser : ""}`}>
      {!isUser ? (
        <span className={ui.turnGutter}>
          <AgentLogo agent={turn.agent} size={20} />
        </span>
      ) : null}
      <div className={ui.turnBody}>
        <div className={ui.turnMeta}>
          {isUser ? (
            <>
              <span className={ui.turnTime}>{clock(turn.ts)}</span>
              <span className={ui.turnName}>{turn.mine ? "You" : `@${turn.login}`}</span>
              <UserAvatar login={turn.login} size={16} />
            </>
          ) : (
            <>
              <span className={`${ui.turnName} ${ui.turnNameAgent}`}>{turn.agent}</span>
              <span className={ui.turnOwner}>@{turn.login}</span>
              <span className={ui.turnTime}>{clock(turn.ts)}</span>
            </>
          )}
        </div>
        {turn.items.map((it) => (
          <MessageBody key={it.key} m={it.m} side={turn.side} />
        ))}
      </div>
    </div>
  );
}

function buildTurns(items: Item[], splitDays: boolean) {
  const turns: Turn[] = [];
  for (const it of items) {
    const side: Turn["side"] = it.m.role === "user" ? "user" : "agent";
    const day = dayLabel(it.ts);
    const last = turns[turns.length - 1];
    const continues =
      last &&
      last.side === side &&
      last.agent === it.agent &&
      last.login === it.login &&
      (!splitDays || last.day === day);
    if (continues) last.items.push(it);
    else turns.push({ key: it.key, side, agent: it.agent, login: it.login, mine: it.mine, ts: it.ts, day, items: [it] });
  }
  return turns;
}

function MessageStream({ items, splitDays }: { items: Item[]; splitDays?: boolean }) {
  const turns = useMemo(() => buildTurns(items, Boolean(splitDays)), [items, splitDays]);
  if (!turns.length) return <div className={ui.empty}>Nothing in this view yet.</div>;
  let lastDay = "";
  return (
    <div className={ui.chat}>
      {turns.map((turn) => {
        const divider = splitDays && turn.day && turn.day !== lastDay ? turn.day : null;
        if (turn.day) lastDay = turn.day;
        return (
          <div key={turn.key} className={ui.turnGroup}>
            {divider ? (
              <div className={ui.dayDivider}>
                <span>{divider}</span>
              </div>
            ) : null}
            <TurnBlock turn={turn} />
          </div>
        );
      })}
    </div>
  );
}

function threadItems(t: ChatThread): Item[] {
  return t.messages.map((m, i) => ({
    key: `${t.id}:${i}`,
    m,
    ts: m.ts || t.updatedAt || 0,
    agent: t.agent,
    login: t.ownerLogin || "local",
    mine: t.mine,
  }));
}

function ThreadCard({ thread }: { thread: ChatThread }) {
  const items = useMemo(() => threadItems(thread), [thread]);
  const lastVisible =
    [...thread.messages].reverse().find((m) => m.kind !== "thinking") ||
    thread.messages[thread.messages.length - 1];
  return (
    <details className={ui.thread}>
      <summary>
        <div className={ui.threadHead}>
          <span className={ui.threadId}>
            <AgentLogo agent={thread.agent} size={18} />
            <strong>{thread.agent}</strong>
            <UserTag login={thread.ownerLogin} mine={thread.mine} />
          </span>
          <span className={ui.threadMeta}>
            {thread.messages.length} msg · {timeAgo(thread.updatedAt)}
          </span>
        </div>
        {lastVisible ? (
          <p className={`${ui.clamp} ${ui.threadPreview}`}>
            {lastVisible.role === "user" ? "You: " : ""}
            {plainPreview(lastVisible.text, 180)}
          </p>
        ) : null}
      </summary>
      <MessageStream items={items} />
    </details>
  );
}

function CombinedView({ threads }: { threads: ChatThread[] }) {
  const items = useMemo(() => {
    const flat = threads.flatMap(threadItems);
    flat.sort((a, b) => a.ts - b.ts);
    return flat.slice(-COMBINED_CAP);
  }, [threads]);
  return <MessageStream items={items} splitDays />;
}

export function AgentSessionChat() {
  const { dashboard } = useRelay();
  const [view, setView] = useState<"sessions" | "combined">("sessions");
  const [agentFilter, setAgentFilter] = useState("all");
  const [userFilter, setUserFilter] = useState("all");

  const threads = dashboard?.chats || [];
  const agents = useMemo(() => [...new Set(threads.map((t) => t.agent))], [threads]);
  const users = useMemo(() => [...new Set(threads.map((t) => t.ownerLogin).filter(Boolean))], [threads]);
  const visible = threads.filter(
    (t) => (agentFilter === "all" || t.agent === agentFilter) && (userFilter === "all" || t.ownerLogin === userFilter)
  );

  if (!threads.length) return <div className={ui.empty}>No transcripts yet. Finish a turn — this list refreshes on its own.</div>;

  return (
    <div className={ui.chatPage}>
      <div className={ui.feedFilters}>
        <div className={ui.viewToggle} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "sessions"}
            className={view === "sessions" ? ui.viewOn : ""}
            onClick={() => setView("sessions")}
          >
            Sessions
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "combined"}
            className={view === "combined" ? ui.viewOn : ""}
            onClick={() => setView("combined")}
          >
            Combined
          </button>
        </div>
        <select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
          <option value="all">All users</option>
          {users.map((u) => (
            <option key={u} value={u}>@{u}</option>
          ))}
        </select>
      </div>

      {!visible.length ? (
        <div className={ui.empty}>No sessions match this filter.</div>
      ) : view === "combined" ? (
        <>
          <div className={ui.combinedBar}>
            <span className={ui.threadMeta}>
              {visible.length} session{visible.length === 1 ? "" : "s"} merged
            </span>
            <span className={ui.combinedAgents}>
              {[...new Set(visible.map((t) => t.agent))].map((a) => (
                <span key={a} className={ui.combinedChip}>
                  <AgentLogo agent={a} size={14} />
                  {a}
                </span>
              ))}
            </span>
          </div>
          <CombinedView threads={visible} />
        </>
      ) : (
        visible.map((thread) => <ThreadCard key={thread.id} thread={thread} />)
      )}
    </div>
  );
}
