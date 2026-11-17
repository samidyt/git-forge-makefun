// git.ts — git smart HTTP: the `/{owner}/{repo}.git` surface.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack    v2 (or v0) advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack   v0 advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                      ls-refs / fetch (v2, v0 fallback)
//   POST /{owner}/{repo}.git/git-receive-pack                     push (v0, report-status, sideband)
//
// The wire shapes mirror what the suite's git-client.ts sends and parses: pkt-line framing,
// sideband bands (1 = data, 2 = progress, 3 = error), v2 sections (acknowledgments,
// shallow-info, packfile), and report-status inside band 1 for pushes. Repositories are
// created through REST only; a push cannot invent one. Every update must fast-forward.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  ZERO_OID,
  cacheGitResponse,
  checkAuth,
  getRepo,
  invalidateGitCache,
  isAncestor,
  listRefs,
  peelTag,
  planFetch,
  readPack,
  writePack,
  branchTip,
  decodePktLines,
  decodePktLinesUntilFlush,
  pktLine,
  pktLines,
  sidebandWrap,
  PKT_FLUSH,
  type Repo,
  type Store,
} from './store.ts';
import { sendBuffer, sendJson } from './respond.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';
const AGENT = 'git-forge/1.0';

function uploadV0Caps(): string {
  return `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
}

function receiveCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
}

/** Parse `/{owner}/{repo}.git/<rest>`; null when the path is not a git path. */
function parseGitPath(pathname: string): { owner: string; repo: string; rest: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repo = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  return { owner, repo, rest: match[3] ?? '' };
}

/** A v0 ref advertisement: service preamble, HEAD + refs (peeled tags), capabilities on line one. */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const key = `ad0:${service}`;
  const cached = repo.gitCache.get(key);
  if (cached !== undefined) return cached;
  const caps = service === 'git-upload-pack' ? uploadV0Caps() : receiveCaps();
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const headTip = branchTip(repo, repo.defaultBranch);
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\u0000${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const peeled = peelTag(repo, oid);
      if (peeled !== oid) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return cacheGitResponse(repo, key, Buffer.concat(parts));
}

/** A protocol-v2 capability advertisement: constant, built once (no repo data in it). */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('# service=git-upload-pack\n'),
  PKT_FLUSH,
  pktLine('version 2\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  pktLine(`agent=${AGENT}\n`),
  PKT_FLUSH,
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** A v2 ls-refs answer: HEAD (with symref-target), refs (with peeled: when asked), prefix-filtered. */
function lsRefsResponse(repo: Repo, opts: LsRefsOptions): Buffer {
  const key = `ls:${opts.peel ? 1 : 0}${opts.symrefs ? 1 : 0}${opts.unborn ? 1 : 0}:${opts.prefixes.join(',')}`;
  const cached = repo.gitCache.get(key);
  if (cached !== undefined) return cached;
  const lines: string[] = [];
  const keep = (name: string): boolean =>
    opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    const headTip = branchTip(repo, repo.defaultBranch);
    const symref = opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    if (headTip !== null) lines.push(`${headTip} HEAD${symref}\n`);
    else if (opts.unborn) lines.push(`unborn HEAD${symref}\n`);
  }
  for (const [ref, oid] of listRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (opts.peel) {
      const peeled = peelTag(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return cacheGitResponse(repo, key, pktLines([...lines, 'flush']));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** A v2 fetch answer: acknowledgments (only when the client sent haves), shallow-info when the
 *  boundary moved on a depth request, then the packfile. A client that sent no haves expects
 *  no acknowledgments section at all (real git fails the fetch otherwise). */
function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const key = `f2:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const cached = repo.gitCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    const acked = args.haves.find((oid) => repo.objects.has(oid));
    const lines: Array<string | 'flush'> = ['acknowledgments\n'];
    if (acked !== undefined) lines.push(`ACK ${acked}\n`, 'ready\n');
    else lines.push('NAK\n');
    lines.push('flush');
    parts.push(pktLines(lines));
  }
  const depthFetch = args.depth !== undefined || plan.unshallow.length > 0;
  if (depthFetch && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(pktLines(lines));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandWrap(1, pack));
    parts.push(PKT_FLUSH);
  }
  return cacheGitResponse(repo, key, Buffer.concat(parts));
}

/** A v0 fetch answer: shallow/unshallow lines, an ACK (or NAK), then the pack in sideband band 1. */
function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const key = `f0:${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const cached = repo.gitCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const lines: Array<string | 'flush'> = [];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  const acked = args.haves.find((oid) => repo.objects.has(oid));
  lines.push(acked !== undefined ? `ACK ${acked}\n` : 'NAK\n');
  const parts: Buffer[] = [pktLines(lines)];
  if (plan.objects.length > 0) parts.push(sidebandWrap(1, writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  return cacheGitResponse(repo, key, Buffer.concat(parts));
}

/** Handle POST git-upload-pack, protocol v2. */
function handleUploadPackV2(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (lines.length === 0 || !lines[0]!.startsWith('command=')) {
    sendBuffer(res, 400, Buffer.from('missing command\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const command = lines[0]!.slice('command='.length).trim();
  // Arguments follow the delim packet; lines before it are agent=/object-format= (ignored).
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind === 'data' && seenDelim) args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    const opts: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') opts.peel = true;
      else if (arg === 'symrefs') opts.symrefs = true;
      else if (arg === 'unborn') opts.unborn = true;
      else if (arg.startsWith('ref-prefix ')) opts.prefixes.push(arg.slice('ref-prefix '.length));
    }
    sendBuffer(res, 200, lsRefsResponse(repo, opts), UPLOAD_RESULT);
    return;
  }
  if (command === 'fetch') {
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
    for (const arg of args) {
      if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const depth = Number(arg.slice(7).trim());
        if (Number.isSafeInteger(depth) && depth > 0) fetchArgs.depth = depth;
      }
    }
    sendBuffer(res, 200, fetchV2Response(repo, fetchArgs), UPLOAD_RESULT);
    return;
  }
  sendBuffer(res, 400, Buffer.from(`unknown command ${command}\n`, 'utf8'), 'text/plain; charset=utf-8');
}

/** Handle POST git-upload-pack, protocol v0 (wants, flush, haves/done). */
function handleUploadPackV0(repo: Repo, body: Buffer, res: ServerResponse): void {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  let afterFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      afterFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterFlush) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0]!;
        args.wants.push(oid);
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const depth = Number(line.slice(7).trim());
        if (Number.isSafeInteger(depth) && depth > 0) args.depth = depth;
      }
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  sendBuffer(res, 200, fetchV0Response(repo, args), UPLOAD_RESULT);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle POST git-receive-pack: unpack the pack, then apply each command with fast-forward rules. */
function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, rest } = decodePktLinesUntilFlush(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) {
      sendBuffer(res, 400, Buffer.from('bad receive-pack command\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    sendBuffer(res, 400, Buffer.from('no receive-pack commands\n', 'utf8'), 'text/plain; charset=utf-8');
    return;
  }
  const sideband = capabilities.split(' ').includes('side-band-64k');
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const lines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      if (current === null) lines.push(`ng ${command.ref} ref does not exist\n`);
      else if (current !== command.oldOid) lines.push(`ng ${command.ref} old value does not match\n`);
      else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        lines.push(`ng ${command.ref} already exists\n`);
        continue;
      }
    } else {
      if (current === null) {
        lines.push(`ng ${command.ref} ref does not exist\n`);
        continue;
      }
      if (current !== command.oldOid) {
        lines.push(`ng ${command.ref} old value does not match\n`);
        continue;
      }
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      lines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      lines.push(`ng ${command.ref} not a commit\n`);
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid && !isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }
  // Objects and/or refs may have moved: drop every memoized git wire response.
  invalidateGitCache(repo);
  // The report stream ends with its own flush INSIDE the sideband data: git's
  // report-status reader waits for that flush and reports "remote end hung up"
  // when the sideband stream ends without it. The outer flush (sideband case)
  // terminates the sideband stream itself.
  const report = pktLines([...lines, 'flush']);
  const out = sideband ? Buffer.concat([sidebandWrap(1, report), PKT_FLUSH]) : report;
  sendBuffer(res, 200, out, RECEIVE_RESULT);
}

/** Route one git smart-HTTP request. Returns true when the path was a git path (handled). */
export function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathname: string,
  query: URLSearchParams,
): boolean {
  const parsed = parseGitPath(pathname);
  if (parsed === null) return false;
  if (!checkAuth(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  const repo = getRepo(store, parsed.owner, parsed.repo);
  if (repo === null) {
    sendJson(res, 404, { message: 'Repository not found' });
    return true;
  }
  try {
    if (req.method === 'GET' && parsed.rest === '/info/refs') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        if ((req.headers['git-protocol'] ?? '') === 'version=2') {
          sendBuffer(res, 200, v2Advertisement(), UPLOAD_AD);
        } else {
          sendBuffer(res, 200, v0Advertisement('git-upload-pack', repo), UPLOAD_AD);
        }
        return true;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, 200, v0Advertisement('git-receive-pack', repo), RECEIVE_AD);
        return true;
      }
      sendJson(res, 400, { message: 'unknown service' });
      return true;
    }
    if (req.method === 'POST' && parsed.rest === '/git-upload-pack') {
      if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(repo, body, res);
      else handleUploadPackV0(repo, body, res);
      return true;
    }
    if (req.method === 'POST' && parsed.rest === '/git-receive-pack') {
      handleReceivePack(repo, body, res);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    // A malformed request must never take the server down: answer 400 and stay healthy.
    sendBuffer(res, 400, Buffer.from(`${err instanceof Error ? err.message : String(err)}\n`, 'utf8'), 'text/plain; charset=utf-8');
    return true;
  }
}
