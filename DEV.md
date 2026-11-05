# Local dev/test rig

A localhost copy of the app to click through a new version **before** deploying it to the
studio server. You run as **admin eran**, with the **same users (agents)** as prod, against
the **real (prod) Evolution**.

> ⚠️ **Evolution is fully live** — the same WhatsApp line as prod. Reads/chats are safe, but
> any **send** (a chat reply, media, a voice note) goes to a **real** number.

Isolation: dev uses its own `data/dev.db`; prod and the `preview.db` sandbox are untouched.

## One-time setup

Seed the dev DB with the prod users. This pulls a read-only copy of the prod DB (prod is not
modified) — host creds are kept outside this repo.

```powershell
# 1. Pull the prod DB next to the seed input (host/creds/hostkey are yours to fill in)
pscp -batch -pw <password> -hostkey "<host-key-fingerprint>" `
  <user>@<host>:/home/eran/webchat-v2/data/webchat.db ./data/prod-webchat.db
# (also copy webchat.db-wal / -shm if present, so recent rows fold in)

# 2. Create data/dev.db (runs migrations) and copy the agents in — idempotent
npm run seed:dev

# 3. Remove the temp copy
Remove-Item ./data/prod-webchat.db*
```

You can re-run step 1–2 anytime to refresh the roster. (Even with no seeding, the first
identity seen on an empty `dev.db` becomes admin, so eran-as-admin always works.)

## Run it (every time you want to test)

With the new version checked out, in **two terminals**:

```powershell
npm run dev:local:api    # backend on :8080, data/dev.db, prod Evolution (live)
npm run dev:local:web    # vite on :5173, injects eran's identity on /api
```

Open <http://localhost:5173> → you're signed in as eran (admin); Settings unlocked.

## Sending without messaging anyone

A **mock Evolution** on `127.0.0.1:9099` accepts every `/message/send*` with a plausible
`key.id` and answers the read endpoints the app calls at boot:

```powershell
node scripts/mock-evolution.mjs          # accepts /message/send*, logs each one
```

Start the `backend-sandbox-mockevo` launch config (port 8090, its own
`data/sandbox-verify.db`) with `frontend-sandbox`. Chat sends "succeed", nothing leaves the
machine. It has no websocket, so `/api/health` reports `"events":"disconnected"` and the UI
shows its live-updates banner — handy for checking degraded mode. Delete the sandbox DB
afterwards.

## Knobs

- **Run as a different user / no identity:** edit `VITE_DEV_AS_EMAIL` in `frontend/.env.local`
  (comment it out for the unrestricted "no identity" path).
- **Backend config:** `.env.dev` (DB path, Evolution creds).

## Files

| File | Role |
| --- | --- |
| `.env.dev` | dev backend config (git-ignored) |
| `frontend/.env.local` | injected dev identity (git-ignored) |
| `scripts/seed-dev-agents.ts` | copies the prod `agents` table into `data/dev.db` |
| `scripts/mock-evolution.mjs` | fake Evolution on `:9099` — accepts sends without messaging anyone |
| `frontend/vite.config.ts` | injects the Access header when `VITE_DEV_AS_EMAIL` is set |
