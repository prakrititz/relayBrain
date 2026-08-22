"use client";

import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ui from "@/styles/ui.module.css";

export function plainPreview(text: string, n = 140) {
  const clean = String(text || "")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

function Code({ className, children }: { className?: string; children?: ReactNode }) {
  const lang = /language-(\w+)/.exec(className || "")?.[1];
  if (!className) return <code className="md-inline">{children}</code>;
  return (
    <code className="md-code" data-lang={lang || undefined}>
      {children}
    </code>
  );
}

export function MarkdownView({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: Code,
          img: ({ src, alt }) => <img src={src} alt={alt || ""} className="md-img" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function ExpandableMarkdown({ text, limit = 360 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const long = String(text || "").length > limit;
  return (
    <div>
      <div className={long && !open ? "md-clamp" : undefined}>
        <MarkdownView text={text} />
      </div>
      {long ? (
        <button
          className={ui.moreBtn}
          type="button"
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
