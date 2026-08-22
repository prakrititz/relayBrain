"use client";

import { useRelay } from "@/lib/RelayContext";
import { Shell } from "@/components/Shell";
import { LoginGate } from "@/components/LoginGate";
import ui from "@/styles/ui.module.css";

export default function Page() {
  const { user, loading } = useRelay();
  if (loading) return <div className={ui.empty}>Booting ./relay…</div>;
  if (!user) return <LoginGate />;
  return <Shell />;
}
