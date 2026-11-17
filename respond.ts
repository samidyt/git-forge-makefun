// respond.ts — tiny shared response helpers for the four surfaces.

import type { ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** Answer with a pre-built JSON body (already stringified, with its trailing newline). */
export function sendPrebuiltJson(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}
