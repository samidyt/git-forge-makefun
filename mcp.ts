// mcp.ts — MCP at `/mcp`: JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON.
//
// Modern era (2026-07-28): `server/discover` answers identity, capabilities and
// supportedVersions in one request; no handshake and no session. The legacy `initialize` +
// `notifications/initialized` handshake is answered too. Six tools over the same store as
// REST, so a repository or issue created here reads back over /api/v3 as the same object.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  checkAuth,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  mergePull,
  type Store,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { sendJson } from './respond.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** One tool definition, built through a helper so the properties record types cleanly. */
function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/** The six tools, in a fixed order: two tools/list answers are byte-identical. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a repository for the authenticated user.',
    {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'The repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  tool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge a pull request with a squash merge.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

type RpcId = string | number | null;

function rpcResult(res: ServerResponse, id: RpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, status: number, id: RpcId, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve owner/repo out of the arguments (a `full_name` of "owner/repo" is the fallback). */
function ownerRepoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = args.owner;
  const repo = args.repo;
  if (typeof owner === 'string' && typeof repo === 'string' && owner !== '' && repo !== '') {
    return { owner, repo };
  }
  const fullName = args.full_name;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (namedOwner !== '' && namedRepo !== '') return { owner: namedOwner, repo: namedRepo };
  }
  return null;
}

function missingArgs(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const name of required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

/** Dispatch one tools/call. Returns a JSON-RPC error code/message, or null on success. */
function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing !== null) {
    return { error: { code: -32602, message: `Missing required argument: ${missing}` } };
  }

  switch (name) {
    case 'create_repo': {
      const created = createRepo(store, args.name as string, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(repoJson(created.repo)) };
    }
    case 'get_repo': {
      const where = ownerRepoOf(args);
      if (!where) return { error: { code: -32602, message: 'Missing required argument: owner/repo' } };
      const repo = getRepo(store, where.owner, where.repo);
      if (!repo) return { result: toolError('Repository not found') };
      return { result: toolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const where = ownerRepoOf(args);
      if (!where) return { error: { code: -32602, message: 'Missing required argument: owner/repo' } };
      const repo = getRepo(store, where.owner, where.repo);
      if (!repo) return { result: toolError('Repository not found') };
      const created = createIssue(store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(issueJson(repo, created.issue)) };
    }
    case 'list_issues': {
      const where = ownerRepoOf(args);
      if (!where) return { error: { code: -32602, message: 'Missing required argument: owner/repo' } };
      const repo = getRepo(store, where.owner, where.repo);
      if (!repo) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return { result: toolResult(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const where = ownerRepoOf(args);
      if (!where) return { error: { code: -32602, message: 'Missing required argument: owner/repo' } };
      const repo = getRepo(store, where.owner, where.repo);
      if (!repo) return { result: toolError('Repository not found') };
      const created = createPull(store, repo, {
        head: args.head as string,
        base: args.base as string,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return { result: toolError(created.error) };
      return { result: toolResult(pullJson(repo, created.pull)) };
    }
    case 'merge_pull_request': {
      const where = ownerRepoOf(args);
      if (!where) return { error: { code: -32602, message: 'Missing required argument: owner/repo' } };
      const repo = getRepo(store, where.owner, where.repo);
      if (!repo) return { result: toolError('Repository not found') };
      const number = Number(args.pull_number);
      if (!Number.isSafeInteger(number)) return { error: { code: -32602, message: 'pull_number must be an integer' } };
      const merged = mergePull(repo, number);
      if (!merged.ok) return { result: toolError(merged.message) };
      const pull = repo.pulls.get(number);
      if (!pull) return { result: toolError('Pull request not found') };
      return { result: toolResult(pullJson(repo, pull)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

/** Route one MCP request. Returns true when the path was /mcp (handled). */
export function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathname: string,
): boolean {
  if (pathname !== '/mcp') return false;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!checkAuth(req.headers.authorization)) {
    rpcError(res, 401, null, -32001, 'Unauthorized');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    rpcError(res, 200, null, -32600, 'Invalid Request');
    return true;
  }
  const id: RpcId =
    typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const isNotification = parsed.id === undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const method = parsed.method;

  if (isNotification) {
    // Notifications (notifications/initialized) are answered with an empty 202, never a result.
    res.writeHead(202);
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      rpcResult(res, id, {
        supportedVersions: [MODERN_REVISION],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        protocolVersion: MODERN_REVISION,
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const offered = params.protocolVersion;
      const negotiated =
        typeof offered === 'string' && LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0]!;
      rpcResult(res, id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        rpcError(res, 200, id, -32602, 'Missing required argument: name');
        return true;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const outcome = callTool(store, toolName, args);
      if ('error' in outcome) {
        rpcError(res, 200, id, outcome.error.code, outcome.error.message);
        return true;
      }
      rpcResult(res, id, outcome.result);
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    default: {
      rpcError(res, 200, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}
