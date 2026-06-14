const fs = require('fs');
const path = require('path');

const IR_FILES = [
  'relay_context.md',
  'compile_brief.md',
  'project.md',
  'current_task.md',
  'decisions.md',
  'failures.md',
  'architecture.md',
  'AGENT_BOOTSTRAP.md',
  'memory.json',
  'config.json',
];

const SKIP_DIRS = new Set(['node_modules', '.git']);

function getRelayDir(workspacePath) {
  return path.join(path.resolve(workspacePath), '.relay');
}

function assertRelayPath(relayDir, relPath) {
  const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = path.resolve(relayDir, normalized);
  if (!full.startsWith(path.resolve(relayDir))) {
    throw new Error('Path escapes .relay directory');
  }
  return { full, rel: normalized.replace(/\\/g, '/') };
}

function listRelayFiles(workspacePath, subPath = '') {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Run relay init first.');
  }

  const { full, rel } = assertRelayPath(relayDir, subPath || '.');
  if (!fs.existsSync(full)) return { path: rel === '.' ? '' : rel, entries: [] };

  const stat = fs.statSync(full);
  if (!stat.isDirectory()) {
    return { path: rel === '.' ? '' : rel, entries: [] };
  }

  const entries = fs
    .readdirSync(full, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') || e.name === '.relay-hook-continuing')
    .filter((e) => !SKIP_DIRS.has(e.name))
    .map((e) => {
      const childRel = rel === '.' || !rel ? e.name : `${rel}/${e.name}`;
      const childFull = path.join(full, e.name);
      const childStat = fs.statSync(childFull);
      return {
        name: e.name,
        path: childRel.replace(/\\/g, '/'),
        type: childStat.isDirectory() ? 'dir' : 'file',
        size: childStat.isFile() ? childStat.size : null,
        updatedAt: childStat.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { path: rel === '.' ? '' : rel, entries };
}

function readRelayFile(workspacePath, relPath) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Run relay init first.');
  }

  const { full, rel } = assertRelayPath(relayDir, relPath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error(`File not found: ${rel}`);
  }

  const stat = fs.statSync(full);
  const content = fs.readFileSync(full, 'utf-8');
  return {
    path: rel,
    content,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function writeRelayFile(workspacePath, relPath, content) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) {
    throw new Error('Workspace not registered. Run relay init first.');
  }

  const { full, rel } = assertRelayPath(relayDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  const stat = fs.statSync(full);
  return {
    path: rel,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
  };
}

function buildRelayTree(workspacePath, maxDepth = 3) {
  const relayDir = getRelayDir(workspacePath);
  if (!fs.existsSync(relayDir)) return [];

  function walk(dir, rel, depth) {
    if (depth > maxDepth) return [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }

    return entries
      .filter((e) => !SKIP_DIRS.has(e.name))
      .filter((e) => !e.name.startsWith('.') || IR_FILES.includes(e.name))
      .map((e) => {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        const childFull = path.join(dir, e.name);
        if (e.isDirectory()) {
          return {
            name: e.name,
            path: childRel.replace(/\\/g, '/'),
            type: 'dir',
            children: walk(childFull, childRel, depth + 1),
          };
        }
        const stat = fs.statSync(childFull);
        return {
          name: e.name,
          path: childRel.replace(/\\/g, '/'),
          type: 'file',
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return walk(relayDir, '', 0);
}

function readIrFiles(workspacePath) {
  const relayDir = getRelayDir(workspacePath);
  const out = {};
  for (const name of IR_FILES) {
    const full = path.join(relayDir, name);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      out[name] = fs.readFileSync(full, 'utf-8');
    }
  }
  return out;
}

module.exports = {
  IR_FILES,
  getRelayDir,
  listRelayFiles,
  readRelayFile,
  writeRelayFile,
  buildRelayTree,
  readIrFiles,
};
