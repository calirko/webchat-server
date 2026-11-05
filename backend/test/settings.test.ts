import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/index.js';
import { FakeEvo, makeApp, testConfig, type TestApp } from './helpers.js';

describe('/api/settings', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('GET exposes the connection without leaking the apikey', async () => {
    const res = (await t.app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(res).toEqual({
      base: 'https://evolution.test',
      instance: 'Test',
      instanceLocked: false,
      apikeySet: true,
      apikeyHint: '••••-key',
      agentsEnabled: false,
      retentionDays: 0,
      notifyInstances: [],
      timezone: expect.any(String),
      serverTime: expect.any(String),
    });
    expect(JSON.stringify(res)).not.toContain('test-key');
  });

  it('PUT updates live config; empty apikey keeps the saved one', async () => {
    const res = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { base: 'https://new.example/', instance: 'Prod', apikey: '', retentionDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ base: 'https://new.example', instance: 'Prod', apikeySet: true });
    // live: consumers read these by reference
    expect(t.cfg.evo.base).toBe('https://new.example');
    expect(t.cfg.evo.apikey).toBe('test-key'); // unchanged
    expect(t.cfg.retentionDays).toBe(7);
  });

  it('PUT round-trips notifyInstances and validates channel names', async () => {
    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyInstances: ['Test', ' Second '] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().notifyInstances).toEqual(['Test', 'Second']); // trimmed
    expect(t.cfg.notifyInstances).toEqual(['Test', 'Second']); // live by reference

    // an unsafe channel name (path-injection guard) is rejected
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { notifyInstances: ['ok', '../evil'] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('saved settings override env config on the next boot', async () => {
    const db = openDb(':memory:');
    const first = await buildApp({ cfg: testConfig(), db, evo: new FakeEvo() });
    await first.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { instance: 'FromDb', apikey: 'db-key', retentionDays: 9 },
    });
    await first.app.close();

    const cfg = testConfig(); // fresh env values
    const second = await buildApp({ cfg, db, evo: new FakeEvo() });
    expect(cfg.evo.instance).toBe('FromDb');
    expect(cfg.evo.apikey).toBe('db-key');
    expect(cfg.retentionDays).toBe(9);
    expect(cfg.evo.base).toBe('https://evolution.test'); // never saved — env wins
    await second.app.close();
    db.close();
  });
});
