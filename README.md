# webchat

A self-hosted shared WhatsApp inbox on top of the [Evolution API](https://doc.evolution-api.com/).
Your team works one or more WhatsApp lines from a single real-time chat view, with assignment,
status, tags, notes, reminders and notifications. You run it on your own server, against your
own Evolution instance — no message ever passes through a third party.

Monorepo with two workspaces:

- **[backend/](backend)** — Node + Fastify + SQLite. Typed Evolution gateway (the API key never
  reaches the browser), SSE event relay, Web Push.
- **[frontend/](frontend)** — React + Vite + TypeScript + Tailwind. Talks only to `/api`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [deploy/README.md](deploy/README.md)
for the production deploy procedure.

## Features

- 💬 **Team inbox.** Every WhatsApp line in one shared, real-time chat view: open/pending/resolved
  status, assignment, tags, per-chat notes and reminders, and unread badges that stay accurate
  across WhatsApp's `@lid`/phone-number aliasing.
- ⚡ **Live.** Incoming messages are written into the open conversation and the chat list the
  moment Evolution's websocket delivers them; a banner says so when live updates are down
  instead of the app just feeling slow.
- 🔔 **Notifications with sound.** A chime for messages in chats you don't have open, a system
  notification when the app is in the background, and Web Push when it's closed. Per person:
  mute groups or DMs, quiet hours, keyword alerts.
- 👥 **Groups.** Browse, create and manage WhatsApp groups; extract participant numbers.
- 🧑‍💼 **Multi-agent, multi-line.** Agents are identified through Cloudflare Access, with
  admin/agent roles and per-agent line grants.
- 🔒 **Everything server-side.** The Evolution API key and base URL never reach the browser.

![Chat](docs/screenshots/chat.png)

*(Screenshot from a local demo instance with fictional contacts and messages.)*

## Development

```bash
npm ci
npm run dev:backend    # API on :8080 (set EVOLUTION_* env to connect a real instance)
npm run dev:frontend   # vite on :5173, proxies /api → :8080
```

Tests and checks:

```bash
npm test               # vitest — in-memory SQLite, faked Evolution API
npm run typecheck      # both workspaces
npm run build          # both workspaces
```

## Production

```bash
cp .env.example .env   # fill in your Evolution API details
docker compose up -d --build
```

One container: the backend serves the API and the built frontend on `:8080`. `./data` is
bind-mounted and holds the SQLite database.

## Configuration

Everything is environment variables — see [.env.example](.env.example). Highlights:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EVOLUTION_BASE` / `EVOLUTION_INSTANCE` / `EVOLUTION_APIKEY` | — | Evolution API connection (server-side only) |
| `EVOLUTION_LOCK_INSTANCE` | `true` | Cap the server to `EVOLUTION_INSTANCE`: other channels are never listed, called or relayed. `false` = multi-channel mode. |
| `API_TOKEN` | *(empty)* | When set, `/api/*` requires it (`X-Api-Token`, `Bearer`, or `?token=` for SSE). Leave empty behind an authenticating proxy. |
| `EVENTS_ENABLED` | `true` | Relay Evolution websocket events via `GET /api/events` (SSE). Needs `WEBSOCKET_ENABLED=true` and `WEBSOCKET_GLOBAL_EVENTS=true` on Evolution. |
| `RETENTION_DAYS` | `0` | Auto-purge attribution/cache rows older than this (0 = off; also a Settings field) |
| `TZ` | `Asia/Jerusalem` (compose) | Zone for notification quiet hours. Unset in a container = UTC |

## API

- `GET /api/health` — version, plus `events`: whether Evolution's websocket is delivering (`connected` / `disconnected` / `off`)
- `POST /api/send` — one immediate send `{recipient, item, isGroup?}`
- `GET /api/chats` · `GET /api/contacts` · `POST /api/messages/find` · `POST /api/media` — typed Evolution gateway (all accept `?instance=`, enforced against per-agent grants)
- `GET /api/chat-meta`, `POST /api/chats/assign|status|tags|notes` — the workbench layer
- `GET/POST /api/reminders` · `GET/PUT /api/notify-prefs` · `POST /api/push/subscribe`
- `GET /api/instances` · `GET /api/maintenance` · `POST /api/maintenance/cleanup` (admin)
- `GET /api/events` — SSE stream of Evolution events (filtered per connection by instance grants)
