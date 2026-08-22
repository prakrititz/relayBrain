"use client";

import { useRelay } from "@/lib/RelayContext";
import { apiUrl } from "@/lib/api";
import ui from "@/styles/ui.module.css";

export function LoginGate() {
  const { users, login } = useRelay();
  return (
    <div className={ui.loginGate}>
      <div className={ui.loginCard}>
        <div className={ui.kicker}>./relay</div>
        <h1>Sign in</h1>
        <p style={{ color: "var(--muted)" }}>
          Run <code>relay login</code> (uses GitHub CLI). Continue with GitHub needs{" "}
          <code>GITHUB_CLIENT_ID</code>. The names below only impersonate a teammate on this machine.
        </p>
        <a className={`${ui.chip} ${ui.full}`} href={apiUrl("/api/auth/github")} style={{ display: "block", textAlign: "center", marginTop: 12 }}>
          Continue with GitHub
        </a>
        {users.map((u) => (
          <button key={u.id} className={`${ui.chip} ${ui.full}`} style={{ width: "100%", marginTop: 8 }} onClick={() => login(u.login)}>
            Continue as {u.name}
          </button>
        ))}
      </div>
    </div>
  );
}
