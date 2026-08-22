"use client";

import { useMemo } from "react";
import { agentBrand } from "@/components/Sidebar";
import { useRelay } from "@/lib/RelayContext";
import ui from "@/styles/ui.module.css";

// GitHub serves an avatar for any handle at github.com/<login>.png, so a peer
// we have never fetched a profile for still gets a face instead of a letter.
const GH_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function AgentLogo({ agent, size = 16 }: { agent?: string | null; size?: number }) {
  const brand = agentBrand(agent || "");
  const px = { width: size, height: size };
  if (!brand) {
    return (
      <span className={ui.idFallback} style={{ ...px, fontSize: Math.round(size * 0.55) }} title={agent || "agent"}>
        {agent?.[0]?.toUpperCase() || "?"}
      </span>
    );
  }
  return <img className={ui.idLogo} src={brand.src} alt={agent || "agent"} title={agent || "agent"} style={px} />;
}

/** login (lowercased) -> avatar URL, from everyone this session knows about. */
export function useAvatars() {
  const { dashboard, user, users } = useRelay();
  return useMemo(() => {
    const map = new Map<string, string>();
    const add = (login?: string | null, url?: string | null) => {
      if (login && url) map.set(login.toLowerCase(), url);
    };
    users?.forEach((u) => add(u.login, u.avatarUrl));
    dashboard?.collaborators?.forEach((c) => add(c.login, c.avatarUrl));
    add(user?.login, user?.avatarUrl);
    return map;
  }, [dashboard?.collaborators, user, users]);
}

export function useAvatarUrl() {
  const avatars = useAvatars();
  return (login?: string | null) => {
    const l = String(login || "").trim();
    if (!l || l.toLowerCase() === "local") return null;
    return avatars.get(l.toLowerCase()) || (GH_LOGIN.test(l) ? `https://github.com/${l}.png?size=64` : null);
  };
}

export function UserAvatar({ login, size = 16 }: { login?: string | null; size?: number }) {
  const urlFor = useAvatarUrl();
  const url = urlFor(login);
  const px = { width: size, height: size };
  const label = login ? `@${login}` : "local";
  if (!url) {
    return (
      <span className={ui.idFallback} style={{ ...px, fontSize: Math.round(size * 0.55) }} title={label}>
        {login?.[0]?.toUpperCase() || "?"}
      </span>
    );
  }
  return <img className={ui.idAvatar} src={url} alt={label} title={label} style={px} />;
}

/** Avatar + @login, for headers and message meta lines. */
export function UserTag({ login, size = 14, mine }: { login?: string | null; size?: number; mine?: boolean }) {
  return (
    <span className={ui.idUser}>
      <UserAvatar login={login} size={size} />
      <span>@{login || "local"}</span>
      {mine ? <span className={ui.idMine}>you</span> : null}
    </span>
  );
}
