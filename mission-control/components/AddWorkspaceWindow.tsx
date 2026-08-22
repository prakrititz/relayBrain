"use client";

import { useEffect, useMemo, useState } from "react";
import { useRelay } from "@/lib/RelayContext";
import { apiUrl } from "@/lib/api";
import { DirectoryPicker } from "./DirectoryPicker";
import ui from "@/styles/ui.module.css";

type Repo = {
  id: string;
  name: string;
  fullName: string;
  owner: string | null;
  ownerAvatarUrl: string | null;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string | null;
  stars: number;
};

type Source = "github" | "clone" | "local" | "room";

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Go: "#00ADD8",
  Rust: "#dea584",
  Java: "#b07219",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Dart: "#00B4AB",
  Vue: "#41b883",
};

function ago(iso: string | null) {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  const h = Math.round(s / 3600);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

/** Full-screen folder chooser, opened on demand from any of the panes. */
function FolderPopup({
  title,
  startAt,
  onPick,
  onClose,
}: {
  title: string;
  startAt: string | null;
  onPick: (p: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={ui.modalBack} style={{ zIndex: 90 }} onClick={onClose}>
      <div className={ui.modal} onClick={(e) => e.stopPropagation()}>
        <div className={ui.kicker}>Choose a folder</div>
        <h2 style={{ marginBottom: 12 }}>{title}</h2>
        <DirectoryPicker startAt={startAt} onPick={onPick} onCancel={onClose} pickLabel="Select this folder" />
      </div>
    </div>
  );
}

export function AddWorkspaceWindow() {
  const { addOpen, setAddOpen, addProject, projects, user } = useRelay();
  const [source, setSource] = useState<Source>("github");

  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Repo | null>(null);

  const [cloneUrl, setCloneUrl] = useState("");
  const [roomUrl, setRoomUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");

  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!addOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !showPicker) setAddOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addOpen, showPicker, setAddOpen]);

  const loadRepos = async (refresh = false) => {
    setLoadingRepos(true);
    setRepoError(null);
    try {
      const res = await fetch(`/api/github/repos${refresh ? "?refresh=1" : ""}`);
      const data = await res.json();
      setRepos(data.repos || []);
      setRepoError(data.error || null);
    } catch {
      setRepoError("Could not reach the repository service");
    } finally {
      setLoadingRepos(false);
    }
  };

  useEffect(() => {
    if (addOpen && source === "github" && repos.length === 0 && !repoError) loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen, source]);

  const addedUrls = useMemo(
    () => new Set(projects.map((p) => (p.remoteUrl || "").toLowerCase().replace(/\.git$/, "")).filter(Boolean)),
    [projects]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q) ||
        (r.language || "").toLowerCase().includes(q)
    );
  }, [repos, query]);

  if (!addOpen) return null;

  const reset = () => {
    setPicked(null);
    setCloneUrl("");
    setRoomUrl("");
    setFolder("");
    setName("");
    setError(null);
  };

  const close = () => {
    reset();
    setAddOpen(false);
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (source === "room") {
        const res = await fetch(apiUrl("/api/room/join"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: roomUrl }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) throw new Error(body.detail || body.error || "Could not join room");
        close();
        return;
      }
      if (source === "local") {
        if (!folder) throw new Error("Choose a folder first");
        await addProject({ mode: "local", path: folder, name: name || undefined });
      } else {
        const url = source === "github" ? picked?.cloneUrl : cloneUrl;
        if (!url) throw new Error("Pick a repository first");
        await addProject({
          mode: "clone",
          remoteUrl: url,
          path: folder || undefined,
          name: name || (source === "github" ? picked?.name : undefined),
        });
      }
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    source === "github"
      ? Boolean(picked)
      : source === "clone"
        ? Boolean(cloneUrl.trim())
        : source === "local"
          ? Boolean(folder)
          : Boolean(roomUrl.trim());

  const NAV: { id: Source; icon: string; title: string; sub: string }[] = [
    { id: "github", icon: "◈", title: "Your repositories", sub: user ? `@${user.login}` : "From GitHub" },
    { id: "clone", icon: "⤓", title: "Custom git clone", sub: "Paste any git URL" },
    { id: "local", icon: "▤", title: "Add local repository", sub: "Browse this computer" },
    { id: "room", icon: "⇄", title: "Join a shared room", sub: "Someone else's coordinator" },
  ];

  return (
    <div className={ui.awWindow}>
      <div className={ui.awTitleBar}>
        <img src="/logo_transparent.png" alt="" />
        <div className={ui.awTitleText}>
          <strong>Add a workspace</strong>
          <span>Clone from GitHub, attach a folder you already have, or join a friend&apos;s room.</span>
        </div>
        <button className={ui.awClose} onClick={close} title="Close (Esc)">
          ✕
        </button>
      </div>

      <div className={ui.awBody}>
        <nav className={ui.awNav}>
          <div className={ui.awNavLabel}>Source</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`${ui.awNavItem} ${source === n.id ? ui.awNavItemOn : ""}`}
              onClick={() => {
                setSource(n.id);
                setError(null);
              }}
            >
              <span className={ui.awNavIcon}>{n.icon}</span>
              <span className={ui.awNavItemText}>
                {n.title}
                <small>{n.sub}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className={ui.awPane}>
          {source === "github" && (
            <>
              <div className={ui.awPaneHead}>
                <h3>Your GitHub repositories</h3>
                <p>
                  Repositories your signed-in GitHub account can push to. Pick one and Relay clones it and wires up the
                  coordinator.
                </p>
              </div>

              <div className={ui.awSearchBar}>
                <input
                  className={ui.awSearch}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name, description or language…"
                />
                <button className={`${ui.chip} ${ui.ghost}`} onClick={() => loadRepos(true)} disabled={loadingRepos}>
                  {loadingRepos ? "Loading…" : "Refresh"}
                </button>
              </div>

              <div className={ui.awRepoList}>
                {loadingRepos && repos.length === 0 ? (
                  <div className={ui.awEmpty}>Reading your repositories from GitHub…</div>
                ) : repoError === "gh_not_installed" ? (
                  <div className={ui.awEmpty}>
                    GitHub CLI isn&apos;t installed, so Relay can&apos;t list your repositories.
                    <br />
                    Install it with <code>winget install GitHub.cli</code>, then run <code>gh auth login</code>.
                    <br />
                    You can still use <strong>Custom git clone</strong> in the meantime.
                  </div>
                ) : repoError === "gh_not_authenticated" ? (
                  <div className={ui.awEmpty}>
                    GitHub CLI is installed but not signed in.
                    <br />
                    Run <code>gh auth login</code> in a terminal, then hit Refresh.
                  </div>
                ) : repoError ? (
                  <div className={ui.awEmpty}>{repoError}</div>
                ) : filtered.length === 0 ? (
                  <div className={ui.awEmpty}>No repositories match “{query}”.</div>
                ) : (
                  filtered.map((r) => {
                    const already = addedUrls.has((r.cloneUrl || "").toLowerCase().replace(/\.git$/, ""));
                    return (
                      <button
                        key={r.id}
                        className={`${ui.awRepoRow} ${picked?.id === r.id ? ui.awRepoRowOn : ""}`}
                        onClick={() => {
                          setPicked(r);
                          setError(null);
                        }}
                      >
                        {r.ownerAvatarUrl ? (
                          <img className={ui.awRepoAvatar} src={r.ownerAvatarUrl} alt="" />
                        ) : (
                          <span className={ui.awRepoAvatar} />
                        )}
                        <span className={ui.awRepoMeta}>
                          <span className={ui.awRepoName}>
                            <span>
                              <span className={ui.awRepoOwner}>{r.owner}/</span>
                              {r.name}
                            </span>
                            {r.private && <span className={ui.badge}>Private</span>}
                            {r.fork && <span className={ui.badge}>Fork</span>}
                            {already && <span className={`${ui.badge} ${ui.mine}`}>Added</span>}
                          </span>
                          {r.description && <span className={ui.awRepoDesc}>{r.description}</span>}
                          <span className={ui.awRepoSub}>
                            {r.language && (
                              <span className={ui.awLang}>
                                <span
                                  className={ui.awLangDot}
                                  style={{ background: LANG_COLORS[r.language] || "var(--muted)" }}
                                />
                                {r.language}
                              </span>
                            )}
                            {r.stars > 0 && <span>★ {r.stars}</span>}
                            {r.updatedAt && <span>Updated {ago(r.updatedAt)}</span>}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              <label className={ui.awLabel}>
                Destination folder <span className={ui.awHint}>(optional — defaults to ~/Documents/GitHub)</span>
              </label>
              <div className={ui.awPathBox}>
                <span className={`${ui.awPathText} ${folder ? "" : ui.awPathEmpty}`}>
                  {folder || "Default location"}
                </span>
                <button className={`${ui.chip} ${ui.ghost}`} onClick={() => setShowPicker(true)}>
                  Browse…
                </button>
              </div>
            </>
          )}

          {source === "clone" && (
            <>
              <div className={ui.awPaneHead}>
                <h3>Custom git clone</h3>
                <p>For anything not in your GitHub account — a different host, an org you aren&apos;t a member of, or an SSH remote.</p>
              </div>
              <label className={ui.awLabel}>Git URL</label>
              <input
                className={ui.field}
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
              />
              <label className={ui.awLabel}>
                Destination folder <span className={ui.awHint}>(optional)</span>
              </label>
              <div className={ui.awPathBox}>
                <span className={`${ui.awPathText} ${folder ? "" : ui.awPathEmpty}`}>
                  {folder || "Default location"}
                </span>
                <button className={`${ui.chip} ${ui.ghost}`} onClick={() => setShowPicker(true)}>
                  Browse…
                </button>
              </div>
              <label className={ui.awLabel}>
                Display name <span className={ui.awHint}>(optional)</span>
              </label>
              <input
                className={ui.field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="urban-stack"
              />
            </>
          )}

          {source === "local" && (
            <>
              <div className={ui.awPaneHead}>
                <h3>Add a local repository</h3>
                <p>Point Relay at a folder that already exists on this machine. Nothing is copied or moved.</p>
              </div>

              {folder ? (
                <>
                  <label className={ui.awLabel}>Selected folder</label>
                  <div className={ui.awPathBox}>
                    <span className={ui.awPathText}>{folder}</span>
                    <button className={`${ui.chip} ${ui.ghost}`} onClick={() => setShowPicker(true)}>
                      Change…
                    </button>
                  </div>
                </>
              ) : (
                <div className={ui.awBigDrop}>
                  <div className={ui.awBigDropIcon}>▤</div>
                  <p>Browse this computer to pick the repository folder.</p>
                  <button className={ui.syncBtn} onClick={() => setShowPicker(true)}>
                    Choose folder…
                  </button>
                </div>
              )}

              <label className={ui.awLabel}>
                Display name <span className={ui.awHint}>(optional — defaults to the folder name)</span>
              </label>
              <input
                className={ui.field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="urban-stack"
              />
            </>
          )}

          {source === "room" && (
            <>
              <div className={ui.awPaneHead}>
                <h3>Join a shared room</h3>
                <p>Paste an invite link, or just hit Join on the Team tab after a teammate invites you.</p>
              </div>
              <label className={ui.awLabel}>Room URL</label>
              <input
                className={ui.field}
                value={roomUrl}
                onChange={(e) => setRoomUrl(e.target.value)}
                  placeholder="https://abc.ngrok-free.app/?relay_invite=…"
              />
            </>
          )}

          {error && <div className={ui.awError}>{error}</div>}

          <div className={ui.awFooter}>
            <div className={ui.awFooterInfo}>
              {source === "github" && picked && (
                <>
                  Cloning <strong>{picked.fullName}</strong>
                  {folder ? ` into ${folder}` : ""}
                </>
              )}
              {source === "local" && folder && (
                <>
                  Attaching <strong>{folder}</strong>
                </>
              )}
            </div>
            <button className={`${ui.chip} ${ui.ghost}`} onClick={close}>
              Cancel
            </button>
            <button className={ui.syncBtn} onClick={submit} disabled={!canSubmit || busy}>
              {busy
                ? "Working…"
                : source === "room"
                  ? "Join room"
                  : source === "local"
                    ? "Add repository"
                    : "Clone repository"}
            </button>
          </div>
        </div>
      </div>

      {showPicker && (
        <FolderPopup
          title={source === "local" ? "Select the repository folder" : "Select where to clone"}
          startAt={folder || null}
          onPick={(p) => {
            setFolder(p);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
