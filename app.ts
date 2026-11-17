// app.ts — the forge's HTTP server: one in-memory store, four surfaces.
//
//   GET  /healthz                  the env's boot probe: 200 {"ok":true}, no auth
//   /api/v3/*                      REST v3 (rest.ts)
//   POST /api/graphql              GraphQL (graphql.ts)
//   POST /mcp                      MCP over JSON-RPC (mcp.ts)
//   /{owner}/{repo}.git/*          git smart HTTP (git.ts)
//
// Every reply carries a non-empty X-GitHub-Request-Id (a deterministic counter, so replays
// agree). Bodies are read whole before dispatch (packs are small; the cap is generous). A
// request that throws is a 500, never a dead process.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendJson } from './respond.ts';

/** The largest request body accepted (packs in the suite are far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Shared empty query params: no handler mutates the query it receives (paginate copies it). */
const EMPTY_QUERY = new URLSearchParams();
/** Shared empty body for requests that carry none. */
const EMPTY_BODY = Buffer.alloc(0);

/** The path and query of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  // Fast path: a plain path with an optional query string (the only shape the suite sends).
  // It returns the same pathname the URL parser would for a well-formed request, without the
  // parse cost. Anything exotic (dot segments, backslashes, fragments, spaces, control
  // characters) falls back to the URL parser below.
  if (
    raw.startsWith('/') &&
    !raw.includes('..') &&
    !raw.includes('\\') &&
    !raw.includes('#') &&
    !/[ \u0000-\u001f\u007f]/.test(raw)
  ) {
    const q = raw.indexOf('?');
    if (q < 0) return { pathname: raw, query: EMPTY_QUERY };
    return { pathname: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
  }
  try {
    const url = new URL(raw, 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: EMPTY_QUERY };
  }
}

/** Read a request body whole. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Route one request through the four handlers (REST, GraphQL, MCP, git) and answer 404
 * when none claims it. Synchronous: callers that already hold the body run this directly
 * instead of paying for an async wrapper per request.
 */
function dispatch(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathname: string,
  query: URLSearchParams,
): void {
  if (handleRest(store, req, res, body, pathname, query)) return;
  if (handleGraphql(store, req, res, body, pathname)) return;
  if (handleMcp(store, req, res, body, pathname)) return;
  if (handleGit(store, req, res, body, pathname, query)) return;
  sendJson(res, 404, { message: 'Not Found' });
}

/** Answer 500 for a dispatch failure; the response may already be gone. */
function send500(res: ServerResponse, err: unknown): void {
  try {
    sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
  } catch {
    // the response is already gone; nothing left to do
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = `req-${store.requestSeq++}`;
    res.setHeader('x-github-request-id', requestId);
    const { pathname, query } = pathOf(req);
    const method = req.method ?? 'GET';
    // The env's boot check calls this twice: 200 {"ok":true}. No auth, no body read.
    if (method === 'GET' && pathname === '/healthz') {
      try {
        sendJson(res, 200, { ok: true });
      } catch (err) {
        send500(res, err);
      }
      return;
    }
    // GET/HEAD never carry a body in this API (GraphQL and MCP require POST; no GET
    // handler reads one): when the request declares no body either, skip the body read
    // entirely — one less async hop per request. A declared body is still consumed, so a
    // keep-alive socket never stalls on unread bytes.
    const hasBody =
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
    if ((method === 'GET' || method === 'HEAD') && !hasBody) {
      // Bodyless request: dispatch synchronously — no promise, no microtask.
      try {
        dispatch(store, req, res, EMPTY_BODY, pathname, query);
      } catch (err) {
        send500(res, err);
      }
      return;
    }
    void (async () => {
      try {
        const body = await readBody(req);
        dispatch(store, req, res, body, pathname, query);
      } catch (err) {
        send500(res, err);
      }
    })();
  });
}
