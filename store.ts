// store.ts — the forge's in-memory state and the git object model.
//
// Everything the four surfaces (git smart HTTP, REST v3, GraphQL, MCP) share lives here:
// repositories, git objects and refs, issues, pull requests, labels and comments, plus the
// git primitives (SHA-1 object hashing, tree/commit/tag parsing and building, packfile
// read/write, the pkt-line codec, reachability walks and three-way merge logic).
//
// Determinism: timestamps come from MAKEFUN_TRIAL_NOW, ids from counters, request ids from a
// counter. No wall clock and no unseeded randomness anywhere in this module, so a trial replay
// against a fresh process produces byte-identical state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- viewer, time, token

/** The competition's fixed viewer: the login the token names (wire.ts buildScenario, seed-fixed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

/** The all-zero object id: an unborn branch's value. */
export const ZERO_OID = '0'.repeat(40);

/** The trial's "now" in Unix seconds: MAKEFUN_TRIAL_NOW, or a fixed fallback when unset. */
function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return 1700000000;
}

export const TRIAL_NOW_SEC = trialNowSec();
export const TRIAL_NOW_ISO = new Date(TRIAL_NOW_SEC * 1000).toISOString();

/** The bearer token this process accepts (MAKEFUN_SHOP_TOKEN; empty in local dev accepts any token). */
export const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether an Authorization header authenticates (missing or wrong token is a 401). */
export function checkAuth(authorization: string | undefined): boolean {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

// ---------------------------------------------------------------- git object model

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8').replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has bad type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes (deterministic: the trial's now, the viewer's identity). */
export function buildCommitBytes(tree: string, parents: readonly string[], message: string): Buffer {
  const who = `${VIEWER.name} <${VIEWER.email}> ${TRIAL_NOW_SEC} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const body = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${body}`, 'utf8');
}

// ---------------------------------------------------------------- pkt-line codec

export const PKT_LINE_MAX = 65520;

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error(`pkt-line payload is ${data.length} bytes, over the limit`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a whole buffer into packets; throws on any malformed or trailing byte. */
export function decodePktLines(buf: Buffer): Packet[] {
  const { packets, rest } = decodePktLinesUntilEnd(buf);
  if (rest.length > 0) throw new Error(`${rest.length} trailing byte(s) after the pkt-line stream`);
  return packets;
}

function decodePktLinesUntilEnd(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Decode pkt-lines up to and including the first flush; the rest is returned untouched (a pack). */
export function decodePktLinesUntilFlush(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      return { packets, rest: buf.subarray(offset) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  throw new Error('pkt-line stream ended without a flush');
}

/** Wrap bytes in sideband frames (band byte + data, chunked to the pkt-line maximum). */
export function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxChunk));
    const payload = Buffer.allocUnsafe(1 + chunk.length);
    payload[0] = band;
    chunk.copy(payload, 1);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- packfiles (plain objects only; the suite never sends deltas)

/** Inflate one zlib stream at `offset` (bounded by `end`); returns its bytes and the next offset. */
function inflateAt(buffer: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read a packfile (version 2/3, plain entries) into objects keyed by id; throws when malformed. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint is too long');
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    const oid = hashObject(type, inflated.data);
    if (!objects.has(oid)) objects.set(oid, { type, data: inflated.data });
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes before its trailer');
  return objects;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects (deduped by id, trailer checksummed). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const seen = new Map<string, GitObject>();
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (!seen.has(oid)) seen.set(oid, object);
  }
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(seen.size, 8);
  parts.push(header);
  for (const object of seen.values()) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- the store

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  nextSeq = 1;
  requestSeq = 1;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/** Look a repository up by owner/name; a name under any other owner is not found, never forbidden. */
export function getRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.repos.get(repoKey(owner, name)) ?? null;
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function createRepo(
  store: Store,
  name: string,
  opts: { description?: string; isPrivate?: boolean } = {},
): { repo: Repo } | { error: string } {
  if (typeof name !== 'string' || !REPO_NAME.test(name)) return { error: 'invalid repository name' };
  if (store.repos.has(repoKey(VIEWER.login, name))) return { error: `repository ${name} already exists` };
  const repo: Repo = {
    id: store.nextRepoId++,
    name,
    owner: VIEWER.login,
    description: opts.description ?? '',
    isPrivate: opts.isPrivate ?? false,
    defaultBranch: DEFAULT_BRANCH,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    seq: store.nextSeq++,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  store.repos.set(repoKey(VIEWER.login, name), repo);
  store.reposById.set(repo.id, repo);
  return { repo };
}

export function deleteRepo(store: Store, repo: Repo): void {
  store.repos.delete(repoKey(repo.owner, repo.name));
  store.reposById.delete(repo.id);
}

// ---------------------------------------------------------------- object helpers on a repo

/** Store an object, returning its id (idempotent: the same bytes hash to the same id). */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Follow annotated tags to the object they point at (the peeled id). */
export function peelTag(repo: Repo, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag' || seen.has(current)) return current;
    seen.add(current);
    current = parseTag(object.data).object;
  }
}

/** Resolve a branch name, a full ref, or a commit id to a commit id; null when unresolvable. */
export function resolveRef(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return peelTag(repo, direct);
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return peelTag(repo, head);
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

/** The tip of a branch by short name, or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Every branch, sorted by name: [{name, sha}]. */
export function listBranches(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** All refs, sorted by name: [[ref, oid]]. */
export function listRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree into path -> entry, recursively. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const stack: Array<{ oid: string; prefix: string }> = [{ oid: treeOid, prefix: '' }];
  while (stack.length) {
    const { oid, prefix } = stack.pop()!;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') stack.push({ oid: entry.oid, prefix: path });
      else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** A commit's file map (empty when the commit is missing). */
export function filesOfCommit(repo: Repo, commitOid: string): Map<string, FileEntry> {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

/** Build nested trees for a file map, storing them; returns the root tree id. */
export function buildTrees(repo: Repo, files: ReadonlyMap<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit on a repo (deterministic identity and timestamp), returning its id. */
export function createCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  return putObject(repo, 'commit', buildCommitBytes(treeOid, parents, message));
}

// ---------------------------------------------------------------- reachability, ancestry, fetch planning

export interface WalkResult {
  /** Every object id reached (commits, trees, blobs, tags). */
  objects: Set<string>;
  /** Commit id -> shortest distance in generations from a root. */
  commits: Map<string, number>;
}

/**
 * Every object reachable from `roots`. `depth` caps the commit generations (commits at distance
 * < depth are included); `stopAt` commits are included with their trees but their parents are not
 * traversed (a shallow clone's boundary). Missing objects are skipped, never an error.
 */
export function walkReachable(
  repo: Repo,
  roots: Iterable<string>,
  opts: { depth?: number; stopAt?: ReadonlySet<string> } = {},
): WalkResult {
  const objects = new Set<string>();
  const commits = new Map<string, number>();
  const depthLimit = opts.depth;
  const stopAt = opts.stopAt;
  const queue: Array<{ oid: string; distance: number }> = [];
  const enqueueCommit = (oid: string, distance: number): void => {
    if (commits.has(oid)) return;
    if (depthLimit !== undefined && distance >= depthLimit) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    commits.set(oid, distance);
    queue.push({ oid, distance });
  };
  const includeTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (objects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') continue;
      objects.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        const child = repo.objects.get(entry.oid);
        if (!child) continue;
        if (child.type === 'tree') stack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  };
  for (const root of roots) {
    let oid = root;
    for (;;) {
      const object = repo.objects.get(oid);
      if (!object) break;
      if (object.type !== 'tag') break;
      if (objects.has(oid)) break;
      objects.add(oid);
      oid = parseTag(object.data).object;
    }
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') enqueueCommit(oid, 0);
    else if (object.type === 'tree') includeTree(oid);
    else objects.add(oid);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const { oid, distance } = queue[index]!;
    objects.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    includeTree(parseCommit(object.data).tree);
    if (stopAt !== undefined && stopAt.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) enqueueCommit(parent, distance + 1);
  }
  return { objects, commits };
}

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Plan a fetch: the objects reachable from `wants` (within `depth` generations when given) that
 * the client does not already hold (reachable from `haves`, stopping at the client's shallow
 * boundaries), plus the new shallow boundary and the boundaries that became interior.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const haveWalk = walkReachable(repo, haves, { stopAt: new Set(shallowBoundaries) });
  const wantWalk = walkReachable(repo, wants, depth === undefined ? {} : { depth });
  const send: GitObject[] = [];
  for (const oid of wantWalk.objects) {
    if (haveWalk.objects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, distance] of wantWalk.commits) {
      if (distance !== depth - 1) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      if (parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
    shallow.sort();
  }
  const held = new Set<string>([...wantWalk.objects, ...haveWalk.objects]);
  const unshallow: string[] = [];
  for (const oid of shallowBoundaries) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (!held.has(oid)) continue;
    if (parseCommit(object.data).parents.every((parent) => held.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();
  return { objects: send, shallow, unshallow };
}

/** True when `ancestor` is reachable from `descendant` by following parents (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge-base of two commits: the nearest common ancestor (breadth-first from `b`). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const queue = [b];
  const seen = new Set<string>();
  for (let index = 0; index < queue.length; index += 1) {
    const oid = queue[index]!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- commits listing

export interface CommitListEntry {
  sha: string;
  message: string;
  author: string;
  committer: string;
  parents: string[];
}

/**
 * Commits reachable from `ref` (default branch when omitted), newest first. Returns null when an
 * explicitly named ref cannot be resolved; an unborn default branch lists nothing.
 */
export function listCommits(repo: Repo, ref?: string): CommitListEntry[] | null {
  let tip: string | null;
  if (ref === undefined || ref === '') {
    tip = branchTip(repo, repo.defaultBranch);
    if (tip === null) return [];
  } else {
    tip = resolveRef(repo, ref);
    if (tip === null) return null;
  }
  const out: CommitListEntry[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, parents: commit.parents });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
  }
  return out;
}

// ---------------------------------------------------------------- contents (REST file API)

export type ContentResult =
  | { ok: true; contentSha: string; commitSha: string; created: boolean }
  | { ok: false; error: string; status: number };

/** Write a file through the contents API, committing it on `branch` (created when missing). */
export function putContent(
  repo: Repo,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentResult {
  const branch = input.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  let parent: string | null = repo.refs.get(refName) ?? null;
  if (parent === null && branch !== repo.defaultBranch) {
    parent = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const parentFiles = parent === null ? new Map<string, FileEntry>() : filesOfCommit(repo, parent);
  const existing = parentFiles.get(input.path);
  if (input.sha !== undefined) {
    if (existing === undefined || existing.oid !== input.sha) {
      return { ok: false, error: 'sha does not match the current file version', status: 409 };
    }
  }
  const blobOid = putObject(repo, 'blob', input.content);
  const files = new Map(parentFiles);
  files.set(input.path, { mode: existing?.mode ?? '100644', oid: blobOid });
  const treeOid = buildTrees(repo, files);
  const commitOid = createCommit(repo, treeOid, parent === null ? [] : [parent], input.message);
  repo.refs.set(refName, commitOid);
  repo.updatedAt = TRIAL_NOW_ISO;
  return { ok: true, contentSha: blobOid, commitSha: commitOid, created: existing === undefined };
}

/** Delete a file through the contents API, committing the removal. */
export function deleteContent(
  repo: Repo,
  input: { path: string; message: string; branch?: string; sha?: string },
): ContentResult {
  const branch = input.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName) ?? null;
  if (parent === null) return { ok: false, error: 'file not found', status: 404 };
  const parentFiles = filesOfCommit(repo, parent);
  const existing = parentFiles.get(input.path);
  if (existing === undefined) return { ok: false, error: 'file not found', status: 404 };
  if (input.sha !== undefined && existing.oid !== input.sha) {
    return { ok: false, error: 'sha does not match the current file version', status: 409 };
  }
  const files = new Map(parentFiles);
  files.delete(input.path);
  const treeOid = buildTrees(repo, files);
  const commitOid = createCommit(repo, treeOid, [parent], input.message);
  repo.refs.set(refName, commitOid);
  repo.updatedAt = TRIAL_NOW_ISO;
  return { ok: true, contentSha: existing.oid, commitSha: commitOid, created: false };
}

export type GetContentResult =
  | { kind: 'file'; name: string; path: string; sha: string; size: number; content: Buffer }
  | {
      kind: 'dir';
      entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }>;
    }
  | null;

/** Read a file or directory at `path` on `ref` (default branch when omitted). */
export function getContent(repo: Repo, path: string, ref?: string): GetContentResult {
  const tip = ref === undefined || ref === '' ? branchTip(repo, repo.defaultBranch) : resolveRef(repo, ref);
  if (tip === null) return null;
  const commitObject = repo.objects.get(tip);
  if (!commitObject || commitObject.type !== 'commit') return null;
  const rootTree = parseCommit(commitObject.data).tree;
  const segments = path === '' ? [] : path.split('/').filter((segment) => segment !== '');
  let treeOid = rootTree;
  for (let i = 0; i < segments.length; i += 1) {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return null;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    const isLast = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (!isLast) {
        treeOid = entry.oid;
        continue;
      }
      return { kind: 'dir', entries: dirEntries(repo, entry.oid, path) };
    }
    if (!isLast) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { kind: 'file', name: entry.name, path, sha: entry.oid, size: blob.data.length, content: blob.data };
  }
  return { kind: 'dir', entries: dirEntries(repo, rootTree, '') };
}

function dirEntries(
  repo: Repo,
  treeOid: string,
  prefix: string,
): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  const out: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }> = [];
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', name: entry.name, path, sha: entry.oid, size: 0 });
    } else {
      const blob = repo.objects.get(entry.oid);
      out.push({ type: 'file', name: entry.name, path, sha: entry.oid, size: blob?.data.length ?? 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- refs (Git Data API)

/** Create a ref at `sha`; 422 when it exists, the sha is unknown, or a branch names a non-commit. */
export function createRef(repo: Repo, ref: string, sha: string): { ok: true } | { ok: false; error: string; status: number } {
  if (!ref.startsWith('refs/')) return { ok: false, error: 'ref must start with refs/', status: 422 };
  if (repo.refs.has(ref)) return { ok: false, error: `ref ${ref} already exists`, status: 422 };
  const object = repo.objects.get(sha);
  if (!object) return { ok: false, error: `object ${sha} not found`, status: 422 };
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
    return { ok: false, error: 'a branch must point at a commit', status: 422 };
  }
  repo.refs.set(ref, sha);
  return { ok: true };
}

// ---------------------------------------------------------------- issues, labels, comments

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: readonly string[] },
): { issue: Issue } | { error: string; status: number } {
  const labels: string[] = [];
  for (const name of input.labels ?? []) {
    if (!repo.labels.has(name)) return { error: `label "${name}" does not exist`, status: 422 };
    labels.push(name);
  }
  const issue: Issue = {
    id: store.nextIssueId++,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    seq: store.nextSeq++,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

export function addComment(store: Store, target: Issue | PullRequest, body: string): IssueComment {
  const comment: IssueComment = {
    id: store.nextCommentId++,
    body,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  target.comments.push(comment);
  target.updatedAt = TRIAL_NOW_ISO;
  return comment;
}

// ---------------------------------------------------------------- pull requests: diff, merge, mergeability

export interface DiffFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts added/removed between two texts (multiset difference, order-free). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of splitLines(newText)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/** Diff two file maps into GitHub-style file entries, sorted by filename. */
export function diffFileMaps(repo: Repo, oldMap: ReadonlyMap<string, FileEntry>, newMap: ReadonlyMap<string, FileEntry>): DiffFile[] {
  const out: DiffFile[] = [];
  const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
  for (const path of paths) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const additions = splitLines(blobText(repo, newEntry.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const deletions = splitLines(blobText(repo, oldEntry.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const { additions, deletions } = lineDiff(blobText(repo, oldEntry.oid), blobText(repo, newEntry.oid));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return out;
}

export function createPull(
  store: Store,
  repo: Repo,
  input: { head: string; base: string; title: string; body?: string },
): { pull: PullRequest } | { error: string; status: number } {
  const headTip = branchTip(repo, input.head);
  const baseTip = branchTip(repo, input.base);
  if (headTip === null) return { error: `head branch ${input.head} not found`, status: 422 };
  if (baseTip === null) return { error: `base branch ${input.base} not found`, status: 422 };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === input.head && existing.base === input.base) {
      return { error: 'a pull request from this head branch is already open', status: 422 };
    }
  }
  const pull: PullRequest = {
    id: store.nextPullId++,
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    head: input.head,
    base: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    seq: store.nextSeq++,
    createdAt: TRIAL_NOW_ISO,
    updatedAt: TRIAL_NOW_ISO,
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

/** A pull request's changed files: the merge-base of base/head tips against the head tip. */
export function prFiles(repo: Repo, pull: PullRequest): DiffFile[] {
  const headTip = branchTip(repo, pull.head);
  if (headTip === null) return [];
  const baseTip = branchTip(repo, pull.base);
  const base = baseTip === null ? null : mergeBase(repo, baseTip, headTip);
  const baseMap = base === null ? new Map<string, FileEntry>() : filesOfCommit(repo, base);
  return diffFileMaps(repo, baseMap, filesOfCommit(repo, headTip));
}

type MergeCheck = { ok: true; merged: Map<string, FileEntry> } | { ok: false; reason: string };

/**
 * Three-way merge check at file granularity: every file the head changed (merge-base -> head)
 * must be unchanged on the base tip (merge-base -> base tip), else it conflicts. On success the
 * merged file map (base tip + the head's changes) is returned.
 */
function checkMerge(repo: Repo, pull: PullRequest): MergeCheck {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'a branch is missing' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseMap = base === null ? new Map<string, FileEntry>() : filesOfCommit(repo, base);
  const headMap = filesOfCommit(repo, headTip);
  const tipMap = filesOfCommit(repo, baseTip);
  const changed: Array<{ path: string; head: FileEntry | undefined }> = [];
  for (const [path, headEntry] of headMap) {
    const baseEntry = baseMap.get(path);
    if ((baseEntry?.oid ?? null) !== headEntry.oid) changed.push({ path, head: headEntry });
  }
  for (const path of baseMap.keys()) {
    if (!headMap.has(path)) changed.push({ path, head: undefined });
  }
  for (const { path } of changed) {
    const baseOid = baseMap.get(path)?.oid ?? null;
    const tipOid = tipMap.get(path)?.oid ?? null;
    if (tipOid !== baseOid) return { ok: false, reason: `conflict in ${path}` };
  }
  const merged = new Map(tipMap);
  for (const { path, head } of changed) {
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return { ok: true, merged };
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; error: 'not-found' | 'conflict' | 'already-merged'; message: string };

/** Squash-merge a pull request: one commit on the base branch carrying the head's changes. */
export function mergePull(repo: Repo, number: number): MergeResult {
  const pull = repo.pulls.get(number);
  if (!pull) return { ok: false, error: 'not-found', message: `pull request #${number} not found` };
  if (pull.state === 'closed') return { ok: false, error: 'already-merged', message: 'pull request is already closed' };
  const baseTip = branchTip(repo, pull.base);
  if (baseTip === null) return { ok: false, error: 'conflict', message: `base branch ${pull.base} not found` };
  const checked = checkMerge(repo, pull);
  if (!checked.ok) return { ok: false, error: 'conflict', message: checked.reason };
  const treeOid = buildTrees(repo, checked.merged);
  const sha = createCommit(repo, treeOid, [baseTip], `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`);
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = sha;
  pull.updatedAt = TRIAL_NOW_ISO;
  return { ok: true, sha };
}

/** A pull request's GraphQL mergeable value. */
export function prMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  if (branchTip(repo, pull.base) === null || branchTip(repo, pull.head) === null) return 'UNKNOWN';
  return checkMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
}

// ---------------------------------------------------------------- global ids (GraphQL)

/** An opaque, stable global id: base64 of `Type:part:part`. */
export function gid(type: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGid(id: string): { type: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const [type, ...parts] = text.split(':');
  if (type === '' || type === undefined || parts.length === 0 || parts.some((part) => part === '')) return null;
  return { type, parts };
}

export function repoGid(repo: Repo): string {
  return gid('Repository', repo.id);
}

export function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', repo.id, issue.number);
}

export function pullGid(repo: Repo, pull: PullRequest): string {
  return gid('PullRequest', repo.id, pull.number);
}

export function commentGid(repo: Repo, comment: IssueComment): string {
  return gid('IssueComment', repo.id, comment.id);
}

/** Resolve a global id to its repository (Repository/Issue/PullRequest/IssueComment ids carry it). */
export function repoOfGid(store: Store, id: string): Repo | null {
  const parsed = parseGid(id);
  if (!parsed) return null;
  const repoId = Number(parsed.parts[0]);
  if (!Number.isSafeInteger(repoId)) return null;
  return store.reposById.get(repoId) ?? null;
}
