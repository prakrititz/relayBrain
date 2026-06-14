// Server-side local directory browser for the "Add Workspace" flow.

import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

function listDrives(): Entry[] {
  const drives: Entry[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push({ name: root, path: root, isDir: true });
    } catch {
      /* drive not ready */
    }
  }
  return drives;
}

export async function GET(request: Request) {
  const dir = new URL(request.url).searchParams.get('path');

  if (!dir) {
    const entries = process.platform === 'win32' ? listDrives() : [{ name: '/', path: '/', isDir: true }];
    return NextResponse.json({ path: null, parent: null, entries });
  }

  const resolved = path.resolve(dir);
  try {
    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    const entries: Entry[] = dirents
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name), isDir: d.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const parent = path.dirname(resolved);
    return NextResponse.json({
      path: resolved,
      parent: parent === resolved ? null : parent,
      entries,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
