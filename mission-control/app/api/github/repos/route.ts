// Lists the signed-in GitHub account's repositories for the "Add workspace"
// window. Runs in the Next.js server process on the same machine as the user,
// so it can shell out to the GitHub CLI directly — the Relay backend is not
// involved and is not modified by this feature.

import { NextResponse } from 'next/server';
import { spawn } from 'child_process';

type GhRepo = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  default_branch: string | null;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  pushed_at: string | null;
  updated_at: string | null;
  stargazers_count: number;
  owner?: { login?: string; avatar_url?: string };
};

const CACHE_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('gh timed out'));
    }, 25_000);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('gh_not_installed'));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `gh exited ${code}`));
    });
  });
}

function classify(message: string) {
  if (message === 'gh_not_installed') return 'gh_not_installed';
  if (/not logged|authentication|gh auth login|HTTP 401/i.test(message)) return 'gh_not_authenticated';
  return message;
}

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('refresh') === '1';
  if (!force && cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body);
  }

  try {
    const raw = await runGh([
      'api',
      'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
      '--paginate',
    ]);
    // --paginate concatenates JSON arrays; normalise "][" joins into one array.
    const list: GhRepo[] = JSON.parse(raw.replace(/\]\s*\[/g, ','));
    const repos = list.map((r) => ({
      id: `gh_${r.id}`,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login ?? null,
      ownerAvatarUrl: r.owner?.avatar_url ?? null,
      description: r.description,
      private: Boolean(r.private),
      fork: Boolean(r.fork),
      language: r.language,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      htmlUrl: r.html_url,
      updatedAt: r.pushed_at || r.updated_at,
      stars: r.stargazers_count || 0,
    }));
    const body = { repos, error: null };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    // Never 500 here — the window renders a helpful empty state off `error`.
    return NextResponse.json({ repos: [], error: classify((err as Error).message) });
  }
}
