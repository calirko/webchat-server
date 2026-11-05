import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeApp, type TestApp } from './helpers.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('maintenance: report + cleanup + retention', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  /** One agent-attribution row, sent `n` days ago. */
  const attribution = (id: string, n: number) =>
    t.db
      .prepare(`INSERT INTO message_agents (message_id, agent_email, sent_at) VALUES (?, ?, ?)`)
      .run(id, 'a@x.com', daysAgo(n));
  const hasAttribution = (id: string) =>
    !!t.db.prepare(`SELECT 1 FROM message_agents WHERE message_id = ?`).get(id);

  it('GET /api/maintenance reports disk, db, table counts and Evolution counts', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.db.sizeBytes).toBeGreaterThan(0);
    expect(body.tables).toMatchObject({ message_agents: 0, reminders: 0 });
    expect(body.evolution).toHaveLength(2);
    expect(body.evolution[1]).toMatchObject({
      name: 'Second',
      connectionStatus: 'close',
      counts: { messages: 222531, contacts: 8070, chats: 5921 },
    });
    expect(JSON.stringify(body)).not.toContain('SECRET-TOKEN');
    expect(body.retentionDays).toBe(0);
  });

  it('cleanup purges old attribution, keeps recent rows; dry run touches nothing', async () => {
    attribution('m-ancient', 90);
    attribution('m-fresh', 2);

    const dry = (
      await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays: 30, dryRun: true },
      })
    ).json();
    expect(dry).toMatchObject({ dryRun: true, messageAgents: 1 });
    expect(hasAttribution('m-ancient')).toBe(true);

    const real = (
      await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays: 30, vacuum: true },
      })
    ).json();
    expect(real).toMatchObject({ dryRun: false, messageAgents: 1, vacuumed: true });
    expect(hasAttribution('m-ancient')).toBe(false);
    expect(hasAttribution('m-fresh')).toBe(true);
  });

  it('rejects bad cutoffs', async () => {
    for (const olderThanDays of [0, -1, 'x', null]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/maintenance/cleanup',
        payload: { olderThanDays },
      });
      expect(res.statusCode, String(olderThanDays)).toBe(400);
    }
  });

  it('retention sweep runs once per day from the housekeeping poll', async () => {
    attribution('ancient', 90);
    t.cfg.retentionDays = 30;
    t.housekeeping.tick();
    expect(hasAttribution('ancient')).toBe(false);

    // same-day second tick must not re-run the sweep
    attribution('ancient2', 90);
    t.housekeeping.tick();
    expect(hasAttribution('ancient2')).toBe(true);
  });

  it('retention 0 (default) never purges', async () => {
    attribution('ancient', 400);
    t.housekeeping.tick();
    expect(hasAttribution('ancient')).toBe(true);
  });

  it('settings round-trip: retentionDays', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { retentionDays: 45 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().retentionDays).toBe(45);
    expect(t.cfg.retentionDays).toBe(45);
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { retentionDays: -1 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
