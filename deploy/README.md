# Deploying to the studio host

The app runs as container `webchat` from `~/webchat-v2` on the studio host
(LAN, reachable via plink; see the operator notes in
`E:\StudioShimshi\Studio Server\CLAUDE.md`). The Cloudflare tunnel routes
`wa.tapdance.co.il → http://webchat:8080` by container name, behind
Cloudflare Access.

## Procedure

The host has no GitHub credentials, so deploys ship an archive rather than a
`git pull`:

1. **Pre-flight:** CI green.
2. `git archive` the merge commit → `pscp` to `/tmp` on the host → extract
   over `~/webchat-v2` (untracked `.env` and `data/` survive).
3. **Mandatory:** `cp deploy/docker-compose.prod.yml docker-compose.yml`.
   The extract overwrites the host compose with the repo's DEV compose —
   host port 8080 collides with Evolution and the container loses its
   `webchat` name, breaking the tunnel route. Skipping this caused a
   ~2-minute outage on 2026-06-12.
4. `docker compose up -d --build`.
5. **Smoke:** `GET /api/health` shows the new version and `"events":"connected"`; chat count sane
   (~1335); `docker logs webchat` shows `[events] connected to Evolution
   websocket`; public hostname still 302s to Cloudflare Access; tunnel
   traffic returns 200s.

Migrations apply automatically on boot.

## Rollback

- Latest deploy: previous image is rebuilt from the previous commit via the
  same procedure.
- v1 (pre-cutover) stays intact at `~/webchat` on the host — image
  `wa-webchat-server:latest` + its `scheduler.db`. Rollback:
  `cd ~/webchat-v2 && docker compose down && cd ~/webchat && docker compose
  up -d`. Keep available through ~2026-06-19; blacklist changes made in v2
  would need re-export.

## Deploy history

Kept locally in `deploy/HISTORY.md` (gitignored), not in the public repo — it
accumulated real customer names/numbers alongside the technical notes. The
public trail is the git log and tags.

## Still open (post-cutover)

All of these need the operator + real WhatsApp (a test contact or the
operator's phone) — they can't be closed from code or the dev rig alone, which
is why they've stayed open.

- **Phone QA of send paths** — run locally against production Evolution and
  verify against a test contact:
  - Chat: text reply; reply-with-quote; voice-note recording; edit own
    message; reaction; delete-for-everyone.
  - Notifications: with the tab in the background, an incoming message
    chimes and shows a system notification; with that chat open and focused,
    nothing; on another tab of the app, a chime.
  - Groups: one management action (rename, add/remove participant).
  - Profile: change status text and revert.
- **v2.11 edit/delete browser QA** — logic is unit-tested against captured
  prod payloads but not yet eyeballed live:
  - Arrive-then-delete shows the original under the tombstone (cache hit).
  - App delete works + shows "Deleted by {agent}"; a phone-side delete
    reflects within ≤10s.
  - Edit a message on the phone, then reload → prior versions survive in the
    "Edited" panel.
  - Edit your own message in the app → instant + "Edited by {agent}" after
    reload.
  - Caveat: only messages seen *after* the 2.11 deploy are cached; older
    deletes/edits fall back to tombstone-only / no history.
- **Credential rotation** — rotate anything that lived in v1 artifacts.
  ⚠️ Rotating the Evolution master key must account for n8n, whose
  workflows may hold the same key.
- **Archive v1** — the v1 frontend repo and server folder, read-only.

**Accepted (not bugs):** manual Retry after a client-side send timeout that
Evolution actually delivered can double-send — deliberate, matches WhatsApp.
