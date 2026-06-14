#!/usr/bin/env node
/**
 * Relay MCP server — agents explore .relay via tools (local files or remote API).
 *
 * Local:  RELAY_WORKSPACE_PATH=/path/to/project
 * Remote: RELAY_API_URL=https://api.relay.dev  RELAY_API_KEY=...
 */
const readline = require('readline');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const store = require(path.join(BACKEND, 'lib', 'relayStore'));
const { syncWorkspace, getRelayContext } = require(path.join(BACKEND, 'relay'));

const MODE = process.env.RELAY_API_URL ? 'remote' : 'local';
const WORKSPACE = process.env.RELAY_WORKSPACE_PATH
  ? path.resolve(process.env.RELAY_WORKSPACE_PATH)
  : process.cwd();
const API_URL = (process.env.RELAY_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.RELAY_API_KEY || '';

const TOOLS = [
  {
    name: 'relay_list_files',
    description: 'List files and folders inside the project .relay directory. Use path="" for root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within .relay (empty for root)' },
      },
    },
  },
  {
    name: 'relay_read_file',
    description: 'Read any file inside .relay (markdown, json, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path, e.g. relay_context.md' },
      },
      required: ['path'],
    },
  },
  {
    name: 'relay_write_file',
    description: 'Write or update a file inside .relay (IR markdown, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'relay_get_context',
    description: 'Regenerate and return relay_context.md handoff bundle.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'relay_sync',
    description: 'Sync agent transcripts into memory.json and refresh compile brief.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function apiFetch(method, urlPath, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function listFiles(subPath) {
  if (MODE === 'remote') {
    const q = new URLSearchParams({
      workspacePath: WORKSPACE,
      path: subPath || '',
    });
    const data = await apiFetch('GET', `/api/relay/files?${q}`);
    return data;
  }
  return store.listRelayFiles(WORKSPACE, subPath || '');
}

async function readFile(relPath) {
  if (MODE === 'remote') {
    const q = new URLSearchParams({ workspacePath: WORKSPACE, path: relPath });
    const data = await apiFetch('GET', `/api/relay/file?${q}`);
    return data.file;
  }
  return store.readRelayFile(WORKSPACE, relPath);
}

async function writeFile(relPath, content) {
  if (MODE === 'remote') {
    const data = await apiFetch('PUT', '/api/relay/file', {
      workspacePath: WORKSPACE,
      path: relPath,
      content,
    });
    return data.file;
  }
  return store.writeRelayFile(WORKSPACE, relPath, content);
}

async function getContext() {
  if (MODE === 'remote') {
    const q = new URLSearchParams({ workspacePath: WORKSPACE });
    const data = await apiFetch('GET', `/api/context?${q}`);
    return { markdown: data.markdown, context: data.context };
  }
  return getRelayContext(WORKSPACE);
}

async function syncRelay() {
  if (MODE === 'remote') {
    return apiFetch('POST', '/api/sync', { workspacePath: WORKSPACE });
  }
  const result = syncWorkspace(WORKSPACE);
  getRelayContext(WORKSPACE);
  return result;
}

async function callTool(name, args) {
  switch (name) {
    case 'relay_list_files': {
      const listing = await listFiles(args.path || '');
      return {
        content: [{ type: 'text', text: JSON.stringify(listing, null, 2) }],
      };
    }
    case 'relay_read_file': {
      const file = await readFile(args.path);
      return {
        content: [{ type: 'text', text: file.content }],
      };
    }
    case 'relay_write_file': {
      const file = await writeFile(args.path, args.content);
      return {
        content: [{ type: 'text', text: `Wrote ${file.path} (${file.size} bytes)` }],
      };
    }
    case 'relay_get_context': {
      const result = await getContext();
      return {
        content: [{ type: 'text', text: result.markdown || '' }],
      };
    }
    case 'relay_sync': {
      const result = await syncRelay();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'relay-os', version: '0.1.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    callTool(params.name, params.arguments || {})
      .then((result) => send({ jsonrpc: '2.0', id, result }))
      .catch((err) =>
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        })
      );
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    handleRequest(JSON.parse(trimmed));
  } catch (err) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } });
  }
});

process.stderr.write(
  `relay-mcp started (${MODE} mode, workspace: ${WORKSPACE})\n`
);
