# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A self-hosted shared WhatsApp inbox built on the [Evolution API](https://doc.evolution-api.com/):
real-time team chat with assignment/status/tags/notes/reminders, groups, and notifications
(in-page chime + system notifications + Web Push). Bulk/scheduled sending, the AI agent,
quick replies and Insights were removed in v3.0 — their DB tables still exist (migrations are
append-only) but nothing reads or writes them. The defining architectural decision: **the frontend talks only to `/api`** — the Evolution base
URL and API key exist exclusively on the server (`backend/src/services/evolution.ts` and the
route layer), never in the browser.

Monorepo, npm workspaces: `backend/` (Node + Fastify + better-sqlite3) and `frontend/`
(React 19 + Vite + TypeScript + Tailwind + react-query + react-router).

Read [README.md](README.md) for the feature list and API surface, [ARCHITECTURE.md](ARCHITECTURE.md)
for the full design (including the live-inbox event path), [DEV.md](DEV.md) for the local dev/test rig, and [deploy/README.md](deploy/README.md) for the
production deploy procedure.

## Commands

```bash
npm ci                          # install (workspaces root)

# Dev servers (2 terminals)
npm run dev:backend             # backend on :8080, whatever Evolution the root .env points at
npm run dev:frontend            # vite on :5173, proxies /api → :8080

# Local rig against prod Evolution (read-only safe; see DEV.md before any send)
npm run dev:local:api           # backend on :8080 via .env.dev, data/dev.db
npm run dev:local:web           # vite on :5173, injects the dev identity

npm run seed:dev                # copy prod agents table into data/dev.db (see DEV.md)

npm test                        # both workspaces — vitest, in-memory SQLite, faked Evolution
npm run typecheck                # both workspaces — tsc --noEmit
npm run build                    # both workspaces
```

Per-workspace (needed for single-test runs — vitest has no root-level passthrough):

```bash
npm -w backend test                          # backend/test/*.test.ts, faked Evolution
npx vitest run backend/test/chatunread.test.ts       # one backend file
npx vitest run -t "ingestUpsert"                     # by test name, any workspace
npm -w frontend test                         # frontend/test/*.test.ts — chat model + live inbox
npm -w backend run typecheck
npm -w frontend run typecheck
```

CI (`.github/workflows/ci.yml`) runs, per workspace: typecheck → test → build. Match that
order locally before considering something done.

Production:

```bash
cp .env.example .env            # fill in EVOLUTION_BASE / EVOLUTION_INSTANCE / EVOLUTION_APIKEY
docker compose up -d --build    # one container serves API + built frontend on :8080
```

`./data` is bind-mounted (SQLite + WAL). Migrations apply automatically at boot
(`backend/src/db/migrations.ts`), in order, no external services.

## Backend architecture (`backend/src/`)

`app.ts` wires Fastify + routes; `index.ts` boots it; `config.ts` reads every env var (single
source of truth for defaults — check it before assuming a knob's default). `routes/*.ts` are
thin — one file per resource, mapping to `services/*.ts` for domain logic and `db/` (SQLite,
better-sqlite3, WAL mode) for persistence. There is deliberately no generic
`{endpoint, body}` Evolution tunnel — every `/api` route maps to one specific typed Evolution
call.

Concepts that span multiple files — read `ARCHITECTURE.md` for the full detail, this is just
the map:

- **Send path**: `POST /api/send` → `services/sender.ts` (thin typed wrapper over Evolution's
  `/message/send*`). Chat replies, media and voice notes all go through it.
- **Event envelope** (`services/envelope.ts#unwrapEvent`): Evolution's global websocket wraps
  every payload as `{instance, data}`. **Every** listener (backend: chat watcher, unread,
  message cache, read receipts, push; frontend: `useEvents.ts#ingestUpsert`) must go through
  the envelope unwrap — a listener that pattern-matches
  fields directly on the raw event silently no-ops in production while passing tests fed bare
  records. This has shipped broken more than once (see `tasks/lessons.md`). New listeners need
  an envelope-shaped test.
- **EventRelay / SSE**: one upstream socket.io connection to Evolution
  (`services/events.ts`), fanned out to browsers over `GET /api/events` (SSE, one-way).
  `/api/health` reports whether that upstream is connected (`events` field).
- **Live inbox (frontend)**: `useLiveInbox` is mounted once in `App` (not in a page — it must
  run on every tab). `ingestUpsert` writes each message straight into cached threads + the chat
  list, then a debounced refetch reconciles. `lib/attention.ts` (open chat + focus) decides
  silent / chime (`lib/sound.ts`) / chime + system notification (`lib/notify.ts`).
- **Housekeeping** (`services/housekeeping.ts`): fires due reminders and the daily retention
  sweep.
- **Roles/authz** (`services/authz.ts`): permission keys checked via `can(agent, key)`;
  routes name a `PermissionKey`. Enforcement is skipped when identification is off or a
  request carries no Cloudflare Access identity (LAN/bearer/automation). First agent ever seen
  becomes admin.
- **Multi-instance**: one Evolution server can host several WhatsApp lines
  (`services/instances.ts`); every Evolution-touching route resolves `?instance=` through
  `InstanceAccess`, enforced against `agents.instances` grants for non-admins.

## Frontend (`frontend/src/`)

`pages/*.tsx` are the top-level views (Chat, Groups, Profile, Preferences, Settings), routed
with react-router; `lib/tabs.ts` lists them. `lib/api.ts` is the only
place that calls `/api`. `lib/chatModel.ts` and friends contain the pure, independently-tested
chat logic (timestamp coercion, `@lid` dedup/aliasing) — keep new chat-shape logic there so it
stays covered by `frontend/test/`. Evolution record shapes (`EvoChat`, `EvoMessage`) are loosely
typed and normalized defensively at the component edge, since Evolution's own shapes drift
across versions.

## Local dev/test rig gotchas (see DEV.md for full detail)

- `dev:local:api`/`dev:local:web` point at **prod Evolution** (same live WhatsApp line) — reads
  are safe, but any send (chat reply, media, voice note) reaches a real number.
- To exercise sends without messaging anyone, use the mock Evolution
  (`node scripts/mock-evolution.mjs`, `:9099`) with the `backend-sandbox-mockevo` launch config
  (`:8090`, `data/sandbox-verify.db`) — delete that sandbox DB when done.
- Stop the `backend` preview (port 8080, real Evolution) before editing backend code, since it
  restarts on file edits; verify against the sandbox instead.

## Known project-specific traps (from `tasks/lessons.md`)

- Never edit JSON files with PowerShell 5.1 `Set-Content -Encoding utf8` — it writes a BOM
  that breaks tsx's package.json parsing. Use the Edit tool or a BOM-less `WriteAllText`.
- `git commit -m @'…'@` here-strings with embedded double quotes get mangled by PS5.1's
  native-arg passing to git — write the message to a file and `git commit -F` it instead.

## Deploy

Deploys to the studio host ship as a `git archive` + `pscp` extract, not `git pull` (no GitHub
creds on the host). **After extracting, `cp deploy/docker-compose.prod.yml docker-compose.yml`
is mandatory** — the repo's dev compose collides with Evolution's port and drops the container
name the Cloudflare tunnel routes by; skipping this caused a real outage on 2026-06-12. Full
procedure, smoke-test checklist, and rollback steps are in `deploy/README.md`.
