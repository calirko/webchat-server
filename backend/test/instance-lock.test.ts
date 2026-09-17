import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventRelay } from '../src/services/events.js';
import { EvolutionClient, lockedOut } from '../src/services/evolution.js';
import { makeApp, testConfig, type TestApp } from './helpers.js';

const cfg = { base: 'https://evo.test', instance: 'Test', apikey: 'k', locked: true };

describe('EVOLUTION_LOCK_INSTANCE: Evolution client guard', () => {
  it('allows only paths that target the locked instance', () => {
    expect(lockedOut('/chat/findChats/Test', cfg)).toBeNull();
    expect(lockedOut('/group/inviteCode/Test?groupJid=1@g.us', cfg)).toBeNull();
    expect(lockedOut('/instance/fetchInstances?instanceName=Test', cfg)).toBeNull();
    expect(lockedOut('/chat/findChats/Second', cfg)).toMatch(/locked/);
    expect(lockedOut('/chat/findChats/Te%73t', cfg)).toBeNull();
    expect(lockedOut('/instance/fetchInstances', cfg)).toMatch(/locked/);
    expect(lockedOut('/instance/fetchInstances?instanceName=Second', cfg)).toMatch(/locked/);
    expect(lockedOut('/instance/create', cfg)).toMatch(/disabled/);
    expect(lockedOut('/chat/findChats/Second', { ...cfg, locked: false })).toBeNull();
  });

  it('never sends a request for a foreign instance', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new EvolutionClient(cfg, fetchFn);
    const denied = await client.call('/chat/findChats/Second');
    expect(denied.status).toBe(403);
    await client.call('/chat/findChats/Test');
    expect(urls).toEqual(['https://evo.test/chat/findChats/Test']);
  });

  it('the relay drops other instances\u2019 websocket events', () => {
    const relay = new EventRelay({ ...cfg, enabled: false }, () => {});
    expect(relay.accepts({ instance: 'Test' })).toBe(true);
    expect(relay.accepts({ instance: 'Second' })).toBe(false);
    expect(relay.accepts(null)).toBe(true);
    relay.reconfigure({ ...cfg, locked: false });
    expect(relay.accepts({ instance: 'Second' })).toBe(true);
  });
});

describe('EVOLUTION_LOCK_INSTANCE: routes', () => {
  let t: TestApp;
  beforeEach(async () => {
    const base = testConfig();
    t = await makeApp({ evo: { ...base.evo, locked: true } });
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  it('lists only the locked channel, scoped upstream, and reports the lock', async () => {
    const body = (await t.app.inject({ method: 'GET', url: '/api/instances' })).json();
    expect(body.locked).toBe(true);
    expect(body.instances.map((i: any) => i.name)).toEqual(['Test']);
    expect(t.evo.calls.at(-1)!.endpoint).toBe('/instance/fetchInstances?instanceName=Test');
  });

  it('refuses other channels even for identity-less requests', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/chats?instance=Second' });
    expect(res.statusCode).toBe(403);
    expect(t.evo.calls.some((c) => c.endpoint.includes('Second'))).toBe(false);
  });

  it('blocks adding channels and switching the channel in settings', async () => {
    const add = await t.app.inject({ method: 'POST', url: '/api/instances', payload: { name: 'Third' } });
    expect(add.statusCode).toBe(403);
    const put = await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { instance: 'Second' } });
    expect(put.statusCode).toBe(403);
    const same = await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { instance: 'Test' } });
    expect(same.statusCode).toBe(200);
    expect(same.json().instanceLocked).toBe(true);
  });
});
