// graphql.ts — GraphQL at `/api/graphql`: a small parser and executor for the fixed documents
// the suite sends (queries, mutations, variables, aliases, inline fragments, batched arrays),
// plus `__type` introspection. Resolves against the same store as REST, so a repository,
// issue or pull request created anywhere reads back here with the same ids.
//
// Global ids are opaque base64 (`Type:repoId:number`), stable across reads, never the plain
// database id. Issue state is OPEN/CLOSED here (lowercase in REST). Unknown fields answer
// HTTP 200 with an `errors` array naming the field; an unknown repository answers
// `data.repository = null` with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  TRIAL_NOW_ISO,
  VIEWER,
  addComment,
  branchTip,
  checkAuth,
  commentGid,
  createIssue,
  createPull,
  gid,
  issueGid,
  mergePull,
  parseGid,
  prFiles,
  prMergeable,
  pullGid,
  repoGid,
  repoOfGid,
  getRepo,
  type Issue,
  type IssueComment,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { sendJson } from './respond.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= source.length) throw new Error('unterminated string');
        const c = source[i]!;
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\\') {
          const esc = source[i + 1];
          if (esc === undefined) throw new Error('unterminated escape');
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += map[esc] ?? esc;
            i += 2;
          }
          continue;
        }
        value += c;
        i += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && isDigit(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && isDigit(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgNode[];
  selections: Selection[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

type Selection = FieldNode | InlineFragmentNode | SpreadNode;

interface ArgNode {
  name: string;
  value: ValueNode;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}", got ${token.kind === 'name' ? token.value : token.kind}`);
    }
  }

  private expectName(what = 'name'): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected ${what}, got ${token.kind}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'name' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      if (this.atPunct('{')) {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      if (this.atName('query') || this.atName('mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.expectName('operation name');
        if (this.atPunct('(')) this.parseVariableDefinitions();
        operations.push({ kind, name, selections: this.parseSelectionSet() });
        continue;
      }
      if (this.atName('fragment')) {
        this.next();
        const name = this.expectName('fragment name');
        if (!this.atName('on')) throw new Error('expected "on" in fragment');
        this.next();
        const typeCondition = this.expectName('fragment type');
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token at document level: ${JSON.stringify(this.peek())}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName('variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('type name');
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        if (this.atName('on')) {
          this.next();
          const typeCondition = this.expectName('inline fragment type');
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (this.peek()?.kind === 'name') {
          selections.push({ kind: 'spread', name: this.expectName('fragment name') });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName('field name');
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        alias = first;
        name = this.expectName('field name');
      }
      const args: ArgNode[] = [];
      if (this.atPunct('(')) {
        this.expectPunct('(');
        while (!this.atPunct(')')) {
          const argName = this.expectName('argument name');
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      const selectionsInner: Selection[] = this.atPunct('{') ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', name, alias, args, selections: selectionsInner });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName('object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token: ${token.kind}`);
  }
}

// ---------------------------------------------------------------- schema: fields, introspection

/** The fields each type answers (unknown fields error, naming the field). */
const SCHEMA_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['id', 'login', 'name', 'email']),
  Repository: new Set([
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt',
    'updatedAt', 'url',
  ]),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'url']),
  IssueConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PageInfo: new Set(['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor']),
  PullRequestConnection: new Set(['nodes', 'pageInfo', 'totalCount']),
  PullRequest: new Set([
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'createdAt', 'updatedAt', 'author',
  ]),
  PullRequestFileConnection: new Set(['nodes', 'pageInfo']),
  PullRequestFile: new Set(['path']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  IssueCommentEdge: new Set(['node']),
  IssueComment: new Set(['id', 'body']),
  Label: new Set(['name', 'color']),
  __Type: new Set(['name', 'fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
});

/** The field lists `__type` reports (the checks require the named ones to be present). */
const INTROSPECTION_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body',
    'createdAt', 'updatedAt', 'author',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt',
    'updatedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
});

const INTROSPECTION_ENUMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
});

// ---------------------------------------------------------------- executor

interface Wrapped {
  t: string;
  v: unknown;
}

const W = (t: string, v: unknown): Wrapped => ({ t, v });

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Resolver = (parent: unknown, args: Record<string, unknown>, ctx: ExecCtx) => Wrapped | null;

const SCALARS = new Set(['String', 'Int', 'Boolean', 'ID']);

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function issueCursor(repo: Repo, number: number): string {
  return Buffer.from(`issue-cursor:${repo.id}:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] !== 'issue-cursor' || parts.length !== 3) return null;
    const number = Number(parts[2]);
    return Number.isSafeInteger(number) ? number : null;
  } catch {
    return null;
  }
}

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function userWrapped(): Wrapped {
  return W('User', VIEWER);
}

function issueWrapped(repo: Repo, issue: Issue): Wrapped {
  return W('Issue', { repo, issue });
}

function pullWrapped(repo: Repo, pull: PullRequest): Wrapped {
  return W('PullRequest', { repo, pull });
}

function pageInfoWrapped(hasNextPage: boolean, endCursor: string | null, startCursor: string | null): Wrapped {
  return W('PageInfo', { hasNextPage, endCursor, startCursor, hasPreviousPage: false });
}

function repoFromInputId(ctx: ExecCtx, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  return repoOfGid(ctx.store, id);
}

function subjectFromId(
  ctx: ExecCtx,
  id: unknown,
): { repo: Repo; issue: Issue } | { repo: Repo; pull: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGid(id);
  if (!parsed) return null;
  const repoId = Number(parsed.parts[0]);
  const number = Number(parsed.parts[1]);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  const repo = ctx.store.reposById.get(repoId) ?? null;
  if (!repo) return null;
  if (parsed.type === 'Issue') {
    const issue = repo.issues.get(number);
    return issue ? { repo, issue } : null;
  }
  if (parsed.type === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull ? { repo, pull } : null;
  }
  return null;
}

const RESOLVERS: Readonly<Record<string, Resolver>> = Object.freeze({
  'Query.viewer': () => userWrapped(),
  'Query.repository': (_parent, args, ctx) => {
    const owner = args.owner;
    const name = args.name;
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    const repo = getRepo(ctx.store, owner, name);
    return repo === null ? null : W('Repository', repo);
  },
  'Query.node': (_parent, args, ctx) => {
    const id = args.id;
    if (typeof id !== 'string') return null;
    const parsed = parseGid(id);
    if (!parsed) return null;
    const repoId = Number(parsed.parts[0]);
    if (!Number.isSafeInteger(repoId)) return null;
    const repo = ctx.store.reposById.get(repoId) ?? null;
    if (!repo) return null;
    if (parsed.type === 'Repository') return W('Repository', repo);
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(Number(parsed.parts[1]));
      return issue ? issueWrapped(repo, issue) : null;
    }
    if (parsed.type === 'PullRequest') {
      const pull = repo.pulls.get(Number(parsed.parts[1]));
      return pull ? pullWrapped(repo, pull) : null;
    }
    return null;
  },
  'Query.__type': (_parent, args) => {
    const name = args.name;
    if (typeof name !== 'string') return null;
    if (INTROSPECTION_FIELDS[name] === undefined && INTROSPECTION_ENUMS[name] === undefined) return null;
    return W('__Type', name);
  },

  'Mutation.createIssue': (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoFromInputId(ctx, input.repositoryId);
    if (!repo || typeof input.title !== 'string') return null;
    const created = createIssue(ctx.store, repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '' });
    if ('error' in created) return null;
    return W('CreateIssuePayload', { repo, issue: created.issue });
  },
  'Mutation.closeIssue': (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const subject = subjectFromId(ctx, input.issueId);
    if (!subject || !('issue' in subject)) return null;
    subject.issue.state = 'closed';
    subject.issue.updatedAt = TRIAL_NOW_ISO;
    return W('CloseIssuePayload', { repo: subject.repo, issue: subject.issue });
  },
  'Mutation.createPullRequest': (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const repo = repoFromInputId(ctx, input.repositoryId);
    if (!repo) return null;
    const head = input.headRefName;
    const base = input.baseRefName;
    const title = input.title;
    if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') return null;
    const created = createPull(ctx.store, repo, {
      head,
      base,
      title,
      body: typeof input.body === 'string' ? input.body : '',
    });
    if ('error' in created) return null;
    return W('CreatePullRequestPayload', { repo, pull: created.pull });
  },
  'Mutation.mergePullRequest': (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const subject = subjectFromId(ctx, input.pullRequestId);
    if (!subject || !('pull' in subject)) return null;
    const merged = mergePull(subject.repo, subject.pull.number);
    if (!merged.ok) return W('MergePullRequestPayload', { repo: subject.repo, pull: subject.pull });
    return W('MergePullRequestPayload', { repo: subject.repo, pull: subject.pull });
  },
  'Mutation.addComment': (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const subject = subjectFromId(ctx, input.subjectId);
    if (!subject || typeof input.body !== 'string') return null;
    const target = 'issue' in subject ? subject.issue : subject.pull;
    const comment = addComment(ctx.store, target, input.body);
    return W('AddCommentPayload', { repo: subject.repo, comment });
  },

  'User.id': () => W('ID', gid('User', VIEWER.id)),
  'User.login': () => W('String', VIEWER.login),
  'User.name': () => W('String', VIEWER.name),
  'User.email': () => W('String', VIEWER.email),

  'Repository.id': (parent) => W('ID', repoGid(parent as Repo)),
  'Repository.databaseId': (parent) => W('Int', (parent as Repo).id),
  'Repository.name': (parent) => W('String', (parent as Repo).name),
  'Repository.nameWithOwner': (parent) => W('String', `${(parent as Repo).owner}/${(parent as Repo).name}`),
  'Repository.owner': () => userWrapped(),
  'Repository.defaultBranchRef': (parent) => {
    const repo = parent as Repo;
    if (branchTip(repo, repo.defaultBranch) === null) return null;
    return W('Ref', repo.defaultBranch);
  },
  'Repository.viewerPermission': () => W('String', 'ADMIN'),
  'Repository.hasIssuesEnabled': () => W('Boolean', true),
  'Repository.description': (parent) => W('String', (parent as Repo).description),
  'Repository.createdAt': (parent) => W('String', (parent as Repo).createdAt),
  'Repository.updatedAt': (parent) => W('String', (parent as Repo).updatedAt),
  'Repository.url': (parent) => W('String', `https://github.com/${(parent as Repo).owner}/${(parent as Repo).name}`),
  'Repository.issue': (parent, args) => {
    const repo = parent as Repo;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const issue = repo.issues.get(number);
    return issue ? issueWrapped(repo, issue) : null;
  },
  'Repository.issues': (parent, args) => {
    const repo = parent as Repo;
    let issues = [...repo.issues.values()];
    const states = args.states;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state)));
      issues = issues.filter((issue) => wanted.has(gqlState(issue.state)));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'ASC' ? 'asc' : orderBy.direction === 'DESC' ? 'desc' : 'asc';
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    const after = cursorNumber(args.after);
    if (after !== null) {
      const index = issues.findIndex((issue) => issue.number === after);
      if (index >= 0) issues = issues.slice(index + 1);
    }
    const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? issueCursor(repo, page[page.length - 1]!.number) : null;
    const startCursor = page.length > 0 ? issueCursor(repo, page[0]!.number) : null;
    return W('IssueConnection', {
      nodes: page.map((issue) => issueWrapped(repo, issue)),
      pageInfo: pageInfoWrapped(hasNextPage, endCursor, startCursor),
      totalCount: issues.length,
    });
  },
  'Repository.pullRequests': (parent, args) => {
    const repo = parent as Repo;
    const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
    const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : pulls.length;
    const page = pulls.slice(0, first);
    const hasNextPage = pulls.length > first;
    return W('PullRequestConnection', {
      nodes: page.map((pull) => pullWrapped(repo, pull)),
      pageInfo: pageInfoWrapped(hasNextPage, null, null),
      totalCount: pulls.length,
    });
  },
  'Repository.pullRequest': (parent, args) => {
    const repo = parent as Repo;
    const number = args.number;
    if (typeof number !== 'number') return null;
    const pull = repo.pulls.get(number);
    return pull ? pullWrapped(repo, pull) : null;
  },

  'Ref.name': (parent) => W('String', parent as string),

  'Issue.id': (parent) => {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    return W('ID', issueGid(repo, issue));
  },
  'Issue.number': (parent) => W('Int', (parent as { issue: Issue }).issue.number),
  'Issue.title': (parent) => W('String', (parent as { issue: Issue }).issue.title),
  'Issue.body': (parent) => W('String', (parent as { issue: Issue }).issue.body),
  'Issue.state': (parent) => W('String', gqlState((parent as { issue: Issue }).issue.state)),
  'Issue.createdAt': (parent) => W('String', (parent as { issue: Issue }).issue.createdAt),
  'Issue.updatedAt': (parent) => W('String', (parent as { issue: Issue }).issue.updatedAt),
  'Issue.author': () => userWrapped(),
  'Issue.url': (parent) => {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    return W('String', `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`);
  },
  'Issue.labels': (parent) => {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    return W('list', issue.labels.map((name) => W('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' })));
  },

  'IssueConnection.nodes': (parent) => W('list', (parent as { nodes: Wrapped[] }).nodes),
  'IssueConnection.pageInfo': (parent) => (parent as { pageInfo: Wrapped }).pageInfo,
  'IssueConnection.totalCount': (parent) => W('Int', (parent as { totalCount: number }).totalCount),

  'PageInfo.hasNextPage': (parent) => W('Boolean', (parent as { hasNextPage: boolean }).hasNextPage),
  'PageInfo.endCursor': (parent) => {
    const cursor = (parent as { endCursor: string | null }).endCursor;
    return cursor === null ? null : W('String', cursor);
  },
  'PageInfo.hasPreviousPage': (parent) => W('Boolean', (parent as { hasPreviousPage: boolean }).hasPreviousPage),
  'PageInfo.startCursor': (parent) => {
    const cursor = (parent as { startCursor: string | null }).startCursor;
    return cursor === null ? null : W('String', cursor);
  },

  'PullRequestConnection.nodes': (parent) => W('list', (parent as { nodes: Wrapped[] }).nodes),
  'PullRequestConnection.pageInfo': (parent) => (parent as { pageInfo: Wrapped }).pageInfo,
  'PullRequestConnection.totalCount': (parent) => W('Int', (parent as { totalCount: number }).totalCount),

  'PullRequest.id': (parent) => {
    const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
    return W('ID', pullGid(repo, pull));
  },
  'PullRequest.number': (parent) => W('Int', (parent as { pull: PullRequest }).pull.number),
  'PullRequest.title': (parent) => W('String', (parent as { pull: PullRequest }).pull.title),
  'PullRequest.body': (parent) => W('String', (parent as { pull: PullRequest }).pull.body),
  'PullRequest.state': (parent) => W('String', gqlState((parent as { pull: PullRequest }).pull.state)),
  'PullRequest.headRefName': (parent) => W('String', (parent as { pull: PullRequest }).pull.head),
  'PullRequest.baseRefName': (parent) => W('String', (parent as { pull: PullRequest }).pull.base),
  'PullRequest.mergeable': (parent) => {
    const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
    return W('String', prMergeable(repo, pull));
  },
  'PullRequest.merged': (parent) => W('Boolean', (parent as { pull: PullRequest }).pull.merged),
  'PullRequest.createdAt': (parent) => W('String', (parent as { pull: PullRequest }).pull.createdAt),
  'PullRequest.updatedAt': (parent) => W('String', (parent as { pull: PullRequest }).pull.updatedAt),
  'PullRequest.author': () => userWrapped(),
  'PullRequest.files': (parent, args) => {
    const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
    const files = prFiles(repo, pull);
    const first = typeof args.first === 'number' && args.first > 0 ? Math.trunc(args.first) : files.length;
    const page = files.slice(0, first);
    return W('PullRequestFileConnection', {
      nodes: page.map((file) => W('PullRequestFile', file.filename)),
      pageInfo: pageInfoWrapped(files.length > first, null, null),
    });
  },

  'PullRequestFileConnection.nodes': (parent) => W('list', (parent as { nodes: Wrapped[] }).nodes),
  'PullRequestFileConnection.pageInfo': (parent) => (parent as { pageInfo: Wrapped }).pageInfo,

  'PullRequestFile.path': (parent) => W('String', parent as string),

  'CreateIssuePayload.issue': (parent) => {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    return issueWrapped(repo, issue);
  },
  'CloseIssuePayload.issue': (parent) => {
    const { repo, issue } = parent as { repo: Repo; issue: Issue };
    return issueWrapped(repo, issue);
  },
  'CreatePullRequestPayload.pullRequest': (parent) => {
    const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
    return pullWrapped(repo, pull);
  },
  'MergePullRequestPayload.pullRequest': (parent) => {
    const { repo, pull } = parent as { repo: Repo; pull: PullRequest };
    return pullWrapped(repo, pull);
  },
  'AddCommentPayload.commentEdge': (parent) => W('IssueCommentEdge', parent),
  'IssueCommentEdge.node': (parent) => {
    const { repo, comment } = parent as { repo: Repo; comment: { id: number; body: string } };
    return W('IssueComment', { repo, comment });
  },
  'IssueComment.id': (parent) => {
    const { repo, comment } = parent as { repo: Repo; comment: IssueComment };
    return W('ID', commentGid(repo, comment));
  },
  'IssueComment.body': (parent) => W('String', (parent as { comment: { body: string } }).comment.body),

  'Label.name': (parent) => W('String', (parent as { name: string }).name),
  'Label.color': (parent) => W('String', (parent as { color: string }).color),

  '__Type.name': (parent) => W('String', parent as string),
  '__Type.fields': (parent) => {
    const fields = INTROSPECTION_FIELDS[parent as string];
    if (fields === undefined) return null;
    return W('list', fields.map((name) => W('__Field', name)));
  },
  '__Type.enumValues': (parent) => {
    const values = INTROSPECTION_ENUMS[parent as string];
    if (values === undefined) return null;
    return W('list', values.map((name) => W('__EnumValue', name)));
  },
  '__Field.name': (parent) => W('String', parent as string),
  '__EnumValue.name': (parent) => W('String', parent as string),
});

function resolveField(parentType: string, parentValue: unknown, field: FieldNode, ctx: ExecCtx): unknown {
  const allowed = SCHEMA_FIELDS[parentType];
  if (allowed === undefined || !allowed.has(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  const resolver = RESOLVERS[`${parentType}.${field.name}`];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
    return null;
  }
  let wrapped: Wrapped | null;
  try {
    wrapped = resolver(parentValue, resolveArgs(field, ctx.variables), ctx);
  } catch (err) {
    ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (wrapped === null) return null;
  if (wrapped.t === 'list') {
    const items = wrapped.v as Wrapped[];
    return items.map((item) => {
      if (field.selections.length === 0) return item.v;
      if (SCALARS.has(item.t)) return item.v;
      return executeSelections(item.t, item.v, field.selections, ctx);
    });
  }
  if (SCALARS.has(wrapped.t)) return wrapped.v;
  if (field.selections.length === 0) return wrapped.v;
  return executeSelections(wrapped.t, wrapped.v, field.selections, ctx);
}

function executeSelections(
  parentType: string,
  parentValue: unknown,
  selections: Selection[],
  ctx: ExecCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.alias ?? selection.name] = resolveField(parentType, parentValue, selection, ctx);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === parentType) {
        Object.assign(out, executeSelections(parentType, parentValue, selection.selections, ctx));
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === parentType) {
        Object.assign(out, executeSelections(parentType, parentValue, fragment.selections, ctx));
      }
    }
  }
  return out;
}

function executeOperation(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation =
    operationName !== undefined
      ? document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0]
      : document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: ExecCtx = { store, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, operation.selections, ctx);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------- the endpoint

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Route one GraphQL request. Returns true when the path was /api/graphql (handled). */
export function handleGraphql(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathname: string,
): boolean {
  if (pathname !== '/api/graphql') return false;
  if (!checkAuth(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return true;
  }
  const runOne = (entry: unknown): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'a query string is required' }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    return executeOperation(store, entry.query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(parsed));
  return true;
}
