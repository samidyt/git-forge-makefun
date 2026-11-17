# git-forge-makefun

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/samidyt/git-forge-makefun/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/samidyt/git-forge-makefun/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in TypeScript (Node 22, stdlib only): git smart HTTP, REST v3, GraphQL and MCP over one deterministic in-memory store. Passes the kit's full local conformance suite: 120/120 checks.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=yza5v0ew&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it implements

- **Git smart HTTP** (`git.ts` + the git core in `store.ts`): protocol v2 upload-pack (`ls-refs`, `fetch`, shallow/deepen, peeled tags, symrefs) and v0 receive-pack (`report-status`, `side-band-64k`, `delete-refs`), exact SHA-1 object hashing, packfile read/write, fast-forward enforcement per ref, mixed ok/ng push reports. Verified against the real `git` binary (clone, push, tag, delete, shallow clone, `fsck` clean) as well as the kit's suite.
- **REST v3** (`rest.ts`): repos, branches, commits, contents (base64, git blob SHAs, stale-sha 409), labels, issues, comments, pull requests with squash merge and conflict detection, pagination with `Link` headers, `X-GitHub-Request-Id` on every reply.
- **GraphQL** (`graphql.ts`): a small lexer/parser/executor for the fixed documents the suite sends — viewer, repository fields, issues connections with cursor pagination, mutations (create/close issue, create/merge pull request, add comment), `__type` introspection, batched operations, stable opaque global ids.
- **MCP** (`mcp.ts`): JSON-RPC 2.0 over Streamable HTTP — modern `server/discover` (2026-07-28) and the legacy `initialize` handshake, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.
- **Determinism**: no wall clock and no unseeded randomness in state — timestamps come from `MAKEFUN_TRIAL_NOW`, ids from counters — so a replayed trial exports identical state.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry point: the kit's lifecycle (bind, register, poll `done`). |
| `app.ts` | One `Store`, one HTTP server, dispatch order REST → GraphQL → MCP → git. |
| `store.ts` | In-memory store + git core (objects, refs, packs, diff, merge). |
| `git.ts` | Git smart-HTTP handlers (v2 upload-pack, v0 receive-pack). |
| `rest.ts` | REST v3 router. |
| `graphql.ts` | GraphQL lexer, parser and executor. |
| `mcp.ts` | MCP JSON-RPC endpoint. |
| `respond.ts` | Small JSON/buffer response helpers. |

## Local verification

The kit's local runner, against a dev harness that listens on a fixed port:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:4123 --token fixture-shop-access --perf --json
```

Result (2026-11-18): **120/120 checks** (git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15) and **163/200 perf points** (push 50, clone 39, read 35, write 39) — an estimated **963/1000** total.
