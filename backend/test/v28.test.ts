import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentPresence } from '../src/services/presence.js';
import { makeApp, type TestApp } from './helpers.js';

const ADMIN = { 'cf-access-authenticated-user-email': 'boss@gmail.com' };
const AGENT = { 'cf-access-authenticated-user-email': 'dana@gmail.com' };

describe('v2.8 agent workbench', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
  });
  afterEach(async () => {
    await t.app.close();
    t.db.close();
  });

  /** Enable agent identification and provision boss (admin) + dana (agent). */
  const enableWithTwoAgents = async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings', payload: { agentsEnabled: true } });
    await t.app.inject({ method: 'GET', url: '/api/me', headers: ADMIN }); // first = admin
    await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT });
  };

  describe('per-agent permission overrides', () => {
    it('role defaults: admin manages settings and agents, agent does not', async () => {
      await enableWithTwoAgents();
      const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT })).json();
      expect(me.role).toBe('agent');
      expect(me.perms).toEqual({ 'settings.manage': false, 'agents.manage': false });
    });

    it('PUT perms grants an agent a permission; only the diff is stored', async () => {
      await enableWithTwoAgents();
      const updated = (
        await t.app.inject({
          method: 'PUT',
          url: '/api/agents/dana%40gmail.com',
          headers: ADMIN,
          payload: { perms: { 'settings.manage': true, 'agents.manage': false } },
        })
      ).json();
      // agents.manage=false matches the role default → not stored as an override
      expect(updated.perms).toEqual({ 'settings.manage': true });
      expect(updated.effectivePerms['settings.manage']).toBe(true);
    });

    it('a deny override can revoke an admin default', async () => {
      await enableWithTwoAgents();
      await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana%40gmail.com',
        headers: ADMIN,
        payload: { role: 'admin', perms: { 'agents.manage': false } },
      });
      const me = (await t.app.inject({ method: 'GET', url: '/api/me', headers: AGENT })).json();
      expect(me.role).toBe('admin');
      expect(me.perms['agents.manage']).toBe(false);
    });

    it('drops unknown (e.g. removed-feature) keys, rejects non-boolean values', async () => {
      await enableWithTwoAgents();
      const stale = await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana%40gmail.com',
        headers: ADMIN,
        payload: { perms: { 'jobs.approve': true } },
      });
      expect(stale.statusCode).toBe(200);
      expect(stale.json().perms).toEqual({});
      const bad = await t.app.inject({
        method: 'PUT',
        url: '/api/agents/dana%40gmail.com',
        headers: ADMIN,
        payload: { perms: { 'settings.manage': 'yes' } },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe('chat meta', () => {
    it('assignment round-trips, validates the agent, and broadcasts', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));

      const bad = await t.app.inject({
        method: 'POST', url: '/api/chats/assign',
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'ghost@x.com' },
      });
      expect(bad.statusCode).toBe(400);

      await t.app.inject({
        method: 'POST', url: '/api/chats/assign', headers: AGENT,
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'dana@gmail.com' },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.assignments['972521111111@s.whatsapp.net'].agentEmail).toBe('dana@gmail.com');
      expect(events.some((e) => e.event === 'CHAT_ASSIGNED')).toBe(true);
    });

    it('deactivating an agent releases their chats', async () => {
      await enableWithTwoAgents();
      await t.app.inject({
        method: 'POST', url: '/api/chats/assign', headers: AGENT,
        payload: { jid: '972521111111@s.whatsapp.net', agentEmail: 'dana@gmail.com' },
      });
      await t.app.inject({
        method: 'PUT', url: '/api/agents/dana%40gmail.com', headers: ADMIN, payload: { active: false },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.assignments).toEqual({});
    });

    it('status overlay auto-reopens on inbound, skipping own sends and aliases', async () => {
      const phone = '972521111111@s.whatsapp.net';
      const lid = '12345@lid';
      await t.app.inject({ method: 'POST', url: '/api/chat-aliases', payload: { pairs: [[lid, phone]] } });
      await t.app.inject({ method: 'POST', url: '/api/chats/status', payload: { jid: phone, status: 'resolved' } });

      // own outbound message must NOT reopen
      t.relay.broadcast({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: phone, fromMe: true } } });
      let meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.statuses[phone].status).toBe('resolved');

      // inbound under the ALIAS jid reopens the row stored under the phone jid
      t.relay.broadcast({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: lid, fromMe: false } } });
      meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.statuses[phone].status).toBe('open');
    });

    it('tags round-trip', async () => {
      await t.app.inject({
        method: 'POST', url: '/api/chats/tags',
        payload: { jid: '972521111111@s.whatsapp.net', tags: ['VIP', 'lead', 'VIP', ''] },
      });
      const meta = (await t.app.inject({ method: 'GET', url: '/api/chat-meta' })).json();
      expect(meta.tags['972521111111@s.whatsapp.net']).toEqual(['lead', 'VIP']);
      expect(meta.allTags).toEqual(['lead', 'VIP']);
    });

    it('notes: own-delete only, admins may delete any', async () => {
      await enableWithTwoAgents();
      const jid = '972521111111@s.whatsapp.net';
      const note = (
        await t.app.inject({ method: 'POST', url: '/api/chats/notes', headers: AGENT, payload: { jid, body: 'waiting on refund' } })
      ).json();
      expect(note.agentEmail).toBe('dana@gmail.com');

      const otherAgent = { 'cf-access-authenticated-user-email': 'yossi@gmail.com' };
      await t.app.inject({ method: 'GET', url: '/api/me', headers: otherAgent });
      const denied = await t.app.inject({ method: 'DELETE', url: `/api/chats/notes/${note.id}`, headers: otherAgent });
      expect(denied.statusCode).toBe(403);
      const ok = await t.app.inject({ method: 'DELETE', url: `/api/chats/notes/${note.id}`, headers: ADMIN });
      expect(ok.statusCode).toBe(200);
      expect((await t.app.inject({ method: 'GET', url: `/api/chats/notes?jid=${encodeURIComponent(jid)}` })).json()).toEqual([]);
    });
  });

  describe('agent presence', () => {
    it('aggregates per agent+chat and expires stale tabs', () => {
      const p = new AgentPresence();
      p.beat('dana@gmail.com', 'tab1', 'chat-a', false);
      p.beat('dana@gmail.com', 'tab2', 'chat-a', true);
      const snap = p.snapshot();
      expect(snap).toEqual([{ email: 'dana@gmail.com', chatJid: 'chat-a', typing: true }]);
      expect(p.snapshot(Date.now() + 60_000)).toEqual([]);
    });

    it('heartbeat broadcasts AGENT_PRESENCE while agents are enabled', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));
      await t.app.inject({
        method: 'POST', url: '/api/agent-presence', headers: AGENT,
        payload: { tabId: 'tab1', chatJid: '972521111111@s.whatsapp.net', typing: false },
      });
      const e = events.find((x) => x.event === 'AGENT_PRESENCE');
      expect(e?.data.agents).toEqual([
        { email: 'dana@gmail.com', chatJid: '972521111111@s.whatsapp.net', typing: false },
      ]);
    });
  });

  describe('reminders', () => {
    it('creates, fires over SSE on the housekeeping poll, and dismisses', async () => {
      await enableWithTwoAgents();
      const events: Array<{ event: string; data: any }> = [];
      t.relay.subscribe((e) => events.push(e as never));

      const r = (
        await t.app.inject({
          method: 'POST', url: '/api/reminders', headers: AGENT,
          payload: { chatJid: '972521111111@s.whatsapp.net', dueAt: new Date(Date.now() - 1000).toISOString(), note: 'call back' },
        })
      ).json();
      expect(r.agentEmail).toBe('dana@gmail.com');

      t.housekeeping.tick();
      const fired = events.find((e) => e.event === 'REMINDER_DUE');
      expect(fired?.data).toMatchObject({ id: r.id, agentEmail: 'dana@gmail.com', note: 'call back' });
      t.housekeeping.tick();
      expect(events.filter((e) => e.event === 'REMINDER_DUE')).toHaveLength(1); // no double fire

      // owners see their own; another agent does not
      const list = (await t.app.inject({ method: 'GET', url: '/api/reminders', headers: AGENT })).json();
      expect(list).toHaveLength(1);
      const otherAgent = { 'cf-access-authenticated-user-email': 'yossi@gmail.com' };
      await t.app.inject({ method: 'GET', url: '/api/me', headers: otherAgent });
      expect((await t.app.inject({ method: 'GET', url: '/api/reminders', headers: otherAgent })).json()).toEqual([]);

      await t.app.inject({ method: 'POST', url: `/api/reminders/${r.id}/dismiss`, headers: AGENT });
      expect((await t.app.inject({ method: 'GET', url: '/api/reminders', headers: AGENT })).json()).toEqual([]);
    });
  });

});
