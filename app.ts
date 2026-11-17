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

/** The path and query of a request URL, or '/' when it does not parse (never a throw). */
function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
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

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${store.requestSeq++}`;
      res.setHeader('x-github-request-id', requestId);
      const { pathname, query } = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}. No auth, no body read.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        const body = await readBody(req);
        if (handleRest(store, req, res, body, pathname, query)) return;
        if (handleGraphql(store, req, res, body, pathname)) return;
        if (handleMcp(store, req, res, body, pathname)) return;
        if (handleGit(store, req, res, body, pathname, query)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          // the response is already gone; nothing left to do
        }
      }
    })();
  });
}
