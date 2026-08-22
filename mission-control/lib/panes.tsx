"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/* Chamber sizing. The center is the workspace, so it wins every negotiation:
   the sides shrink to their minimums first, and only then does one of them
   collapse. Defaults are the widths the layout shipped with. */
export const RAIL_W = 60; // the workspace icon rail, left of the LEFT chamber
export const LEFT_MIN = 240;
export const LEFT_MAX = 520;
export const LEFT_DEFAULT = 248;
export const RIGHT_MIN = 240;
export const RIGHT_MAX = 520;
export const RIGHT_DEFAULT = 268;
export const CENTER_MIN = 400;

const KEY = "relay.panes.v1";

export type PaneState = {
  left: number;
  right: number;
  leftOpen: boolean;
  rightOpen: boolean;
};

const DEFAULTS: PaneState = {
  left: LEFT_DEFAULT,
  right: RIGHT_DEFAULT,
  leftOpen: true,
  rightOpen: true,
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Squeeze, then collapse — never let the center fall under its minimum. */
function fit(s: PaneState, vw: number): PaneState {
  const avail = vw - RAIL_W;
  let { left, right, leftOpen, rightOpen } = s;
  const room = () => avail - (leftOpen ? left : 0) - (rightOpen ? right : 0);

  if (room() < CENTER_MIN && rightOpen) right = clamp(right, RIGHT_MIN, Math.max(RIGHT_MIN, right + room() - CENTER_MIN));
  if (room() < CENTER_MIN && leftOpen) left = clamp(left, LEFT_MIN, Math.max(LEFT_MIN, left + room() - CENTER_MIN));
  // Still short at both minimums: drop a chamber rather than crush the center.
  if (room() < CENTER_MIN && rightOpen) rightOpen = false;
  if (room() < CENTER_MIN && leftOpen) leftOpen = false;

  if (left === s.left && right === s.right && leftOpen === s.leftOpen && rightOpen === s.rightOpen) return s;
  return { left, right, leftOpen, rightOpen };
}

/** How wide a side may get right now, given the other side and the center. */
function maxFor(side: "left" | "right", s: PaneState, vw: number) {
  const other = side === "left" ? (s.rightOpen ? s.right : 0) : s.leftOpen ? s.left : 0;
  const headroom = vw - RAIL_W - other - CENTER_MIN;
  return Math.max(side === "left" ? LEFT_MIN : RIGHT_MIN, Math.min(side === "left" ? LEFT_MAX : RIGHT_MAX, headroom));
}

/* The four layouts the switcher offers. They are views of the same three
   chambers — nothing is created or destroyed, only shown or hidden. */
export type PanePreset = "all" | "left" | "right" | "center";

export function presetOf(s: Pick<PaneState, "leftOpen" | "rightOpen">): PanePreset {
  if (s.leftOpen && s.rightOpen) return "all";
  if (s.leftOpen) return "left";
  if (s.rightOpen) return "right";
  return "center";
}

export type Panes = PaneState & {
  dragging: "left" | "right" | null;
  preset: PanePreset;
  startDrag: (side: "left" | "right", e: React.PointerEvent) => void;
  nudge: (side: "left" | "right", delta: number) => void;
  reset: (side: "left" | "right") => void;
  setPreset: (preset: PanePreset) => void;
};

const PanesCtx = createContext<Panes | null>(null);

export function PanesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaneState>(DEFAULTS);
  const [dragging, setDragging] = useState<"left" | "right" | null>(null);
  // Reads during render would desync SSR markup, so restore after mount.
  const hydrated = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<PaneState>;
        setState((s) => ({
          left: clamp(Number(saved.left) || s.left, LEFT_MIN, LEFT_MAX),
          right: clamp(Number(saved.right) || s.right, RIGHT_MIN, RIGHT_MAX),
          leftOpen: saved.leftOpen !== false,
          rightOpen: saved.rightOpen !== false,
        }));
      }
    } catch {
      /* private mode, blocked storage — defaults are fine */
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  useEffect(() => {
    const onResize = () => setState((s) => fit(s, window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = useCallback((side: "left" | "right", e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(side);
    const move = (ev: PointerEvent) => {
      const vw = window.innerWidth;
      const raw = side === "left" ? ev.clientX - RAIL_W : vw - ev.clientX;
      const s = stateRef.current;
      const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
      const next = clamp(Math.round(raw), min, maxFor(side, s, vw));
      setState((cur) => (cur[side] === next ? cur : { ...cur, [side]: next }));
    };
    const up = () => {
      setDragging(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  const nudge = useCallback((side: "left" | "right", delta: number) => {
    setState((s) => {
      const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
      return { ...s, [side]: clamp(s[side] + delta, min, maxFor(side, s, window.innerWidth)) };
    });
  }, []);

  const reset = useCallback((side: "left" | "right") => {
    setState((s) => ({ ...s, [side]: side === "left" ? LEFT_DEFAULT : RIGHT_DEFAULT }));
  }, []);

  // Hiding a chamber keeps its width around; showing it lands there again.
  const setPreset = useCallback((preset: PanePreset) => {
    setState((s) =>
      fit(
        {
          ...s,
          leftOpen: preset === "all" || preset === "left",
          rightOpen: preset === "all" || preset === "right",
        },
        window.innerWidth
      )
    );
  }, []);

  const value = useMemo<Panes>(
    () => ({ ...state, dragging, preset: presetOf(state), startDrag, nudge, reset, setPreset }),
    [state, dragging, startDrag, nudge, reset, setPreset]
  );
  return <PanesCtx.Provider value={value}>{children}</PanesCtx.Provider>;
}

export function usePanes() {
  const ctx = useContext(PanesCtx);
  if (!ctx) throw new Error("usePanes outside PanesProvider");
  return ctx;
}
