# Architecture

A shared WhatsApp inbox on top of the Evolution API. It started as a rewrite of a
single 479 KB `index.html` that called Evolution straight from the browser. The
defining decision since then: **the frontend talks only to `/api`**. The Evolution
base URL and API key exist only on the server.

```
   ┌────────────────────────────┐
   │   frontend/  (React SPA)   │  Vite + TS + Tailwind + react-query
   └─────────────┬──────────────┘
                 │  /api only (fetch + SSE)
   ┌─────────────┴──────────────┐
   │   backend/   native API    │  Fastify
   │                            │
   │  chat meta · reminders ·   │──► services/ + db/ (SQLite)
   │  agents · push · settings  │
   │  chats · messages · media  │──► typed Evolution gateway (apikey here)
   │  send · groups · profile   │
   │  events (SSE)              │──► EventRelay ◄── Evolution websocket
   └────────────────────────────┘
```

## Backend

- **Typed gateway, not a proxy.** Each `/api` route maps to one specific
  Evolution endpoint. There is deliberately no generic `{endpoint, body}`
  tunnel. `POST /api/send` (`services/sender.ts`) is the one send path: chat
  replies, media and voice notes all go through it.
- **EventRelay** (`services/events.ts`). The server holds one upstream
  socket.io connection to Evolution and fans events out to browsers over SSE
  (`/api/events`). It tracks whether that socket is connected, and
  `/api/health` reports it as `events: connected | disconnected | off`.
- **Event envelope.** Evolution's global websocket wraps every payload in
  `{instance, data}`. `services/envelope.ts#unwrapEvent` is the single place
  that flattens it (it also handles bare records, arrays and `{messages:[…]}`).
  Every backend listener goes through it: chat watcher, unread tracking, message
  cache, read receipts, push. The SSE stream carries the envelope verbatim, and
  the frontend unwraps it with the same rules in `lib/useEvents.ts`.
- **Workbench** (`services/chatmeta.ts`, `reminders.ts`, `presence.ts`):
  per-chat assignment, open/pending/resolved status, tags, internal notes, the
  `@lid`↔phone alias map, follow-up reminders and live agent presence. Chat keys
  are canonicalized server-side.
- **Shared unread** (`services/chatunread.ts`). Evolution's `findChats`
  unread count is unreliable, so the relay counts incoming messages per chat and
  the read/unread endpoints move a shared cursor. Every agent sees the same badge.
- **Message cache / read receipts** (`msgcache.ts`, `readreceipts.ts`). These
  snapshot message bodies as they arrive, so a delete-for-everyone or an edit can
  still show the original. They also stamp the read time from the live ack, which
  is the only place it is ever carried.
- **Web Push** (`services/push.ts`). A VAPID keypair is generated once and kept
  in SQLite. Browsers subscribe via `PushManager`, and a relay listener pushes
  each inbound message. Routing follows chat assignment (assigned → that agent,
  unassigned → everyone) and per-person prefs (`notifyprefs.ts`: groups/DMs,
  quiet hours, keywords). `notify_instances` controls which lines notify at all.
  The notification tag is the canonical chat jid, so a push and the page's own
  notification for the same chat replace each other instead of stacking.
- **Housekeeping** (`services/housekeeping.ts`). One poll (`POLL_MS`) fires
  due reminders over SSE and runs the daily retention sweep.
- **Roles** (`services/authz.ts`). The permission keys are `settings.manage`
  and `agents.manage`; routes name a key, and `can(agent, key)` resolves the role
  default plus any per-agent override. Enforcement is skipped while agent
  identification is off, or when a request carries no Cloudflare Access identity
  (LAN/bearer/automation). The first agent ever seen becomes admin. Unknown keys
  left in `agents.perms` by removed features are ignored.
- **Multi-instance.** One Evolution server can host several WhatsApp lines.
  Every Evolution-touching route resolves `?instance=` through `InstanceAccess`.
  Names are validated for everyone, and grants are enforced for identified
  non-admin agents. `EVOLUTION_LOCK_INSTANCE` (the default) caps the server to
  one line.
- **Maintenance.** `GET /api/maintenance` reports disk, DB and table sizes plus
  Evolution's per-instance counts. `POST /api/maintenance/cleanup` and the
  `retention_days` sweep prune old attribution, cached bodies, edits and fired
  reminders. They also clear out rows left in the legacy campaign tables.
- SQLite in WAL mode, ordered migrations applied at boot, no external
  services. Migrations are append-only, so tables from removed features (jobs,
  lists, blacklist, AI agent, …) still exist but nothing writes to them.

## Frontend

React SPA with react-query for all data. `lib/api.ts` is the only place that
calls `/api`. Evolution record shapes (`EvoChat`, `EvoMessage`) are loosely typed
and normalized defensively in `lib/chatModel.ts`, because Evolution's shapes drift
across versions. Its pure functions are unit-tested in `frontend/test/`.

**Live inbox** (`lib/useEvents.ts#useLiveInbox`, mounted once in `App` so it
runs on every tab). For each `MESSAGES_UPSERT`, `ingestUpsert`:

1. writes the message straight into every cached thread whose jid set contains
   it (`applyLiveMessages`, which also folds in edits and deletes);
2. bumps the chat-list row (`applyLiveToChats`);
3. returns who to ping. A debounced refetch (1.5s) and the throttled chat-list
   refresh reconcile afterwards.

The ping decision works like this:

| Situation | Result |
| --- | --- |
| That chat is open and the window has focus | Nothing |
| The app is in front, but on another chat | Chime (`lib/sound.ts`) |
| The app is hidden or unfocused | Chime and a system notification |

Messages older than five minutes when they arrive are history replays from a
reconnect, so they update the caches but never ping. `lib/attention.ts` holds the
open thread's jids and the "looking" check.

**Degraded mode.** `lib/eventBus.ts` reconnects with backoff (1s → 15s) and
refetches after a reconnect, since events sent during the gap are lost. If
either the browser's stream or the server's Evolution socket is down for more
than 5s, a banner says so. The chat-list poll then tightens from 60s to 10s; the
open thread already polls every 10s.

## Verification stance

Domain logic is covered by fast tests with a faked Evolution (`backend/test/`).
Every relay listener has an envelope-shaped test, and so does the frontend's
`ingestUpsert`. **Chat parity can only be proven against a live instance.**
Read-only endpoints are safe to verify headlessly; send paths need a real phone.

## Status

In production on the studio host since 2026-06-12. v3.0 cut the app down to the
inbox. It removed bulk/scheduled sending (the send ledger, lists, blacklist,
number verification, cold-contact pacing, opt-out), the AI agent, quick replies,
the tools page and Insights. In the same release it made inbound messages render
from the event itself and added sound plus focus-aware notifications on every
tab. Deploy procedure, history and rollback live in
[deploy/README.md](deploy/README.md).
