// rest.ts — REST v3: the `/api/v3` surface.
//
// Repositories, branches, commits, contents, labels, issues, comments and pull requests, all
// over the one in-memory store the git surface writes. Every reply is application/json with a
// string `message` on errors; the router (app.ts) adds X-GitHub-Request-Id to every reply.
// Authentication: a missing or wrong bearer token is 401; a repository under any other owner
// than the token's login is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  TRIAL_NOW_ISO,
  VIEWER,
  addComment,
  branchTip,
  checkAuth,
  createIssue,
  createPull,
  createRef,
  createRepo,
  deleteContent,
  deleteRepo,
  getContent,
  getRepo,
  invalidateIssueJson,
  listBranches,
  listCommits,
  mergePull,
  prFiles,
  putContent,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { sendJson, sendPrebuiltJson } from './respond.ts';

// ---------------------------------------------------------------- JSON shapes

function userJson(): { login: string; id: number; type: string } {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: Repo, name: string): { name: string; color: string } {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/**
 * The single-issue REST response text (issueJson, stringified, trailing newline included),
 * memoized on the issue while it is unchanged. A hit is byte-identical to a fresh
 * serialization; every issue mutation clears the memo (see invalidateIssueJson).
 */
function issueJsonText(repo: Repo, issue: Issue): string {
  const cached = issue.jsonCache;
  if (cached !== null && cached !== undefined) return cached;
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  issue.jsonCache = text;
  return text;
}

function refJson(repo: Repo, ref: string): { ref: string; sha: string; label: string; user: unknown; repo: unknown } {
  const sha = branchTip(repo, ref) ?? '0'.repeat(40);
  return {
    ref,
    sha,
    label: `${repo.owner}:${ref}`,
    user: userJson(),
    repo: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}` },
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: refJson(repo, pull.head),
    base: refJson(repo, pull.base),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

/** `Name <email> ts tz` -> {name, email, date} (the date is the stored timestamp, never the clock). */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: TRIAL_NOW_ISO };
  return {
    name: match[1] ?? '',
    email: match[2] ?? '',
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------- helpers

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false };

function parseBody(body: Buffer): BodyResult {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) if (typeof entry === 'string') out.push(entry);
  return out;
}

/** Slice a list into one page; returns the page and the Link header value (or null). */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
): { page: T[]; link: string | null } {
  const perPageRaw = Number(query.get('per_page') ?? 30);
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number(query.get('page') ?? 1);
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page >= totalPages) return { page: slice, link: null };
  const nextQuery = new URLSearchParams(query);
  nextQuery.set('per_page', String(perPage));
  nextQuery.set('page', String(page + 1));
  const lastQuery = new URLSearchParams(query);
  lastQuery.set('per_page', String(perPage));
  lastQuery.set('page', String(totalPages));
  return {
    page: slice,
    link: `<${baseUrl}?${nextQuery.toString()}>; rel="next", <${baseUrl}?${lastQuery.toString()}>; rel="last"`,
  };
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

// ---------------------------------------------------------------- the router

/** Route one REST request. Returns true when the path was under /api/v3 (handled). */
export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  pathname: string,
  query: URLSearchParams,
): boolean {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  if (!checkAuth(req.headers.authorization)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let sub = pathname.slice('/api/v3'.length);
  if (sub === '') sub = '/';
  if (sub.length > 1 && sub.endsWith('/')) sub = sub.slice(0, -1);
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? '127.0.0.1';
  const baseUrl = `http://${host}${pathname}`;

  try {
    // API root and meta.
    if (method === 'GET' && sub === '/') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return true;
    }
    if (method === 'GET' && sub === '/meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    if (method === 'GET' && sub === '/user') {
      sendJson(res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        created_at: TRIAL_NOW_ISO,
        updated_at: TRIAL_NOW_ISO,
      });
      return true;
    }

    // The viewer's repositories.
    if (sub === '/user/repos') {
      if (method === 'GET') {
        const repos = [...store.repos.values()]
          .filter((repo) => repo.owner === VIEWER.login)
          .sort((a, b) => a.seq - b.seq);
        const { page, link } = paginate(repos, query, baseUrl);
        sendJson(res, 200, page.map(repoJson), link === null ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const name = asString(parsed.value.name);
        if (name === undefined || name === '') {
          sendJson(res, 422, { message: 'name is required' });
          return true;
        }
        const created = createRepo(store, name, {
          description: asString(parsed.value.description) ?? '',
          isPrivate: asBoolean(parsed.value.private) ?? false,
        });
        if ('error' in created) {
          sendJson(res, 422, { message: created.error });
          return true;
        }
        sendJson(res, 201, repoJson(created.repo));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    // Repository-scoped routes.
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(sub);
    if (repoMatch === null) {
      notFound(res);
      return true;
    }
    const owner = decode(repoMatch[1]!);
    const repoName = decode(repoMatch[2]!);
    const rest = repoMatch[3] ?? '';
    const repo = getRepo(store, owner, repoName);
    if (repo === null) {
      notFound(res, 'Repository not found');
      return true;
    }

    if (rest === '') {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const description = asString(parsed.value.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(parsed.value.private);
        if (isPrivate !== undefined) repo.isPrivate = isPrivate;
        repo.updatedAt = TRIAL_NOW_ISO;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        deleteRepo(store, repo);
        res.writeHead(204);
        res.end();
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    // Branches.
    if (rest === '/branches' && method === 'GET') {
      sendJson(
        res,
        200,
        listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
      );
      return true;
    }
    const branchMatch = /^\/branches\/(.+)$/.exec(rest);
    if (branchMatch !== null && method === 'GET') {
      const branch = decode(branchMatch[1]!);
      const sha = branchTip(repo, branch);
      if (sha === null) {
        notFound(res, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha } });
      return true;
    }

    // Commits.
    if (rest === '/commits' && method === 'GET') {
      const sha = query.get('sha') ?? undefined;
      const commits = listCommits(repo, sha);
      if (commits === null) {
        notFound(res, 'Commit not found');
        return true;
      }
      const { page } = paginate(commits, query, baseUrl);
      sendJson(
        res,
        200,
        page.map((entry) => ({
          sha: entry.sha,
          commit: {
            message: entry.message,
            author: parseIdent(entry.author),
            committer: parseIdent(entry.committer),
          },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
          parents: entry.parents.map((parent) => ({ sha: parent })),
        })),
      );
      return true;
    }

    // Git Data: refs.
    if (rest === '/git/refs' && method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (ref === undefined || sha === undefined) {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return true;
      }
      const created = createRef(repo, ref, sha);
      if (!created.ok) {
        sendJson(res, created.status, { message: created.error });
        return true;
      }
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }
    const refMatch = /^\/git\/refs\/(.+)$/.exec(rest);
    if (refMatch !== null && method === 'GET') {
      const ref = `refs/${decode(refMatch[1]!)}`;
      const sha = repo.refs.get(ref) ?? null;
      if (sha === null) {
        notFound(res, 'Reference not found');
        return true;
      }
      sendJson(res, 200, { ref, object: { sha } });
      return true;
    }

    // Contents.
    const contentsMatch = /^\/contents(?:\/(.*))?$/.exec(rest);
    if (contentsMatch !== null) {
      const rawPath = contentsMatch[1] ?? '';
      const filePath = decode(rawPath);
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const found = getContent(repo, filePath, ref);
        if (found === null) {
          notFound(res, 'File not found');
          return true;
        }
        if (found.kind === 'file') {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.size,
            name: found.name,
            path: found.path,
            sha: found.sha,
            content: found.content.toString('base64'),
          });
          return true;
        }
        sendJson(
          res,
          200,
          found.entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.sha,
            size: entry.size,
          })),
        );
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const content = asString(parsed.value.content);
        if (content === undefined) {
          sendJson(res, 422, { message: 'content is required' });
          return true;
        }
        const message = asString(parsed.value.message) ?? `Update ${filePath}`;
        const result = putContent(repo, {
          path: filePath,
          content: Buffer.from(content, 'base64'),
          message,
          branch: asString(parsed.value.branch),
          sha: asString(parsed.value.sha),
        });
        if (!result.ok) {
          sendJson(res, result.status, { message: result.error });
          return true;
        }
        sendJson(
          res,
          result.created ? 201 : 200,
          {
            content: {
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              sha: result.contentSha,
              size: Buffer.from(content, 'base64').length,
              encoding: 'base64',
              type: 'file',
            },
            commit: { sha: result.commitSha, message },
          },
        );
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const message = asString(parsed.value.message) ?? `Delete ${filePath}`;
        const result = deleteContent(repo, {
          path: filePath,
          message,
          branch: asString(parsed.value.branch),
          sha: asString(parsed.value.sha),
        });
        if (!result.ok) {
          sendJson(res, result.status, { message: result.error });
          return true;
        }
        sendJson(res, 200, { commit: { sha: result.commitSha, message } });
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    // Labels.
    if (rest === '/labels') {
      if (method === 'GET') {
        sendJson(
          res,
          200,
          [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })),
        );
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const name = asString(parsed.value.name);
        if (name === undefined || name === '') {
          sendJson(res, 422, { message: 'name is required' });
          return true;
        }
        const color = asString(parsed.value.color) ?? 'ededed';
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color });
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    // Issues.
    if (rest === '/issues') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { page, link } = paginate(issues, query, baseUrl);
        sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link === null ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const title = asString(parsed.value.title);
        if (title === undefined || title === '') {
          sendJson(res, 422, { message: 'title is required' });
          return true;
        }
        const created = createIssue(store, repo, {
          title,
          body: asString(parsed.value.body) ?? '',
          labels: asStringArray(parsed.value.labels) ?? [],
        });
        if ('error' in created) {
          sendJson(res, created.status, { message: created.error });
          return true;
        }
        sendPrebuiltJson(res, 201, issueJsonText(repo, created.issue));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const issueCommentsMatch = /^\/issues\/(\d+)\/comments$/.exec(rest);
    if (issueCommentsMatch !== null) {
      const number = Number(issueCommentsMatch[1]);
      const target = repo.issues.get(number) ?? repo.pulls.get(number) ?? null;
      if (target === null) {
        notFound(res, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, target.comments.map(commentJson));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const commentBody = asString(parsed.value.body);
        if (commentBody === undefined) {
          sendJson(res, 422, { message: 'body is required' });
          return true;
        }
        const comment = addComment(store, target, commentBody);
        sendJson(res, 201, commentJson(comment));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const issueMatch = /^\/issues\/(\d+)$/.exec(rest);
    if (issueMatch !== null) {
      const number = Number(issueMatch[1]);
      const issue = repo.issues.get(number) ?? null;
      const pull = issue === null ? repo.pulls.get(number) ?? null : null;
      if (issue === null && pull === null) {
        notFound(res, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        if (issue !== null) {
          sendPrebuiltJson(res, 200, issueJsonText(repo, issue));
          return true;
        }
        // A pull request read as an issue, GitHub-style.
        sendJson(res, 200, {
          ...issueJson(repo, {
            id: pull!.id,
            number: pull!.number,
            title: pull!.title,
            body: pull!.body,
            state: pull!.state,
            labels: [],
            comments: pull!.comments,
            seq: pull!.seq,
            createdAt: pull!.createdAt,
            updatedAt: pull!.updatedAt,
          }),
          pull_request: {
            url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull!.number}`,
            html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull!.number}`,
          },
        });
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const target = issue ?? pull!;
        const state = asString(parsed.value.state);
        if (state === 'open' || state === 'closed') target.state = state;
        const title = asString(parsed.value.title);
        if (title !== undefined) target.title = title;
        const bodyText = asString(parsed.value.body);
        if (bodyText !== undefined) target.body = bodyText;
        target.updatedAt = TRIAL_NOW_ISO;
        if (issue !== null) {
          invalidateIssueJson(issue);
          sendPrebuiltJson(res, 200, issueJsonText(repo, issue));
          return true;
        }
        sendJson(res, 200, pullJson(repo, pull!));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    // Pull requests.
    if (rest === '/pulls') {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(pulls, query, baseUrl);
        sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), link === null ? {} : { link });
        return true;
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const head = asString(parsed.value.head);
        const base = asString(parsed.value.base);
        const title = asString(parsed.value.title);
        if (head === undefined || base === undefined || title === undefined || title === '') {
          sendJson(res, 422, { message: 'head, base and title are required' });
          return true;
        }
        const created = createPull(store, repo, { head, base, title, body: asString(parsed.value.body) ?? '' });
        if ('error' in created) {
          sendJson(res, created.status, { message: created.error });
          return true;
        }
        sendJson(res, 201, pullJson(repo, created.pull));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(rest);
    if (pullFilesMatch !== null && method === 'GET') {
      const pull = repo.pulls.get(Number(pullFilesMatch[1]));
      if (!pull) {
        notFound(res, 'Pull request not found');
        return true;
      }
      sendJson(res, 200, prFiles(repo, pull));
      return true;
    }
    const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(rest);
    if (pullMergeMatch !== null && method === 'PUT') {
      const result = mergePull(repo, Number(pullMergeMatch[1]));
      if (!result.ok) {
        if (result.error === 'not-found') sendJson(res, 404, { message: result.message });
        else sendJson(res, 405, { message: result.message });
        return true;
      }
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(rest);
    if (pullMatch !== null) {
      const pull = repo.pulls.get(Number(pullMatch[1]));
      if (!pull) {
        notFound(res, 'Pull request not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const state = asString(parsed.value.state);
        if (state === 'open' || state === 'closed') pull.state = state;
        const title = asString(parsed.value.title);
        if (title !== undefined) pull.title = title;
        pull.updatedAt = TRIAL_NOW_ISO;
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }

    notFound(res);
    return true;
  } catch (err) {
    // A request must never take the server down.
    try {
      sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
    } catch {
      // the response is already gone; nothing left to do
    }
    return true;
  }
}
