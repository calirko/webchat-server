import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { EventRelay } from '../services/events.js';
import { SAFE_INSTANCE } from '../services/instances.js';
import type { SettingKey, SettingsStore } from '../services/settings.js';

interface SettingsDeps {
  cfg: Config;
  store: SettingsStore;
  relay: EventRelay;
  requireAdmin: preHandlerHookHandler;
}

/** The settings shape sent to the browser — the apikey itself never leaves the server. */
function publicSettings(cfg: Config) {
  return {
    base: cfg.evo.base,
    instance: cfg.evo.instance,
    instanceLocked: cfg.evo.locked && !!cfg.evo.instance,
    apikeySet: !!cfg.evo.apikey,
    apikeyHint: cfg.evo.apikey ? `••••${cfg.evo.apikey.slice(-4)}` : '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    serverTime: new Date().toISOString(),
    agentsEnabled: cfg.agentsEnabled,
    retentionDays: cfg.retentionDays,
    notifyInstances: cfg.notifyInstances,
  };
}

export function registerSettings(app: FastifyInstance, deps: SettingsDeps): void {
  const { cfg, store, relay, requireAdmin } = deps;

  // Open to all agents. No secrets here — the apikey never leaves the server.
  app.get('/api/settings', async () => publicSettings(cfg));

  // Partial update; empty/missing apikey means "keep the saved one".
  app.put('/api/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Record<SettingKey, string>> = {};

    if (typeof b.base === 'string') patch.evo_base = b.base.trim().replace(/\/+$/, '');
    if (typeof b.instance === 'string' && b.instance.trim() !== cfg.evo.instance) {
      if (cfg.evo.locked)
        return reply.code(403).send({ error: `channel is locked to "${cfg.evo.instance}" (EVOLUTION_LOCK_INSTANCE)` });
      patch.evo_instance = b.instance.trim();
    }
    if (typeof b.apikey === 'string' && b.apikey.trim()) patch.evo_apikey = b.apikey.trim();

    if (typeof b.agentsEnabled === 'boolean') patch.agents_enabled = b.agentsEnabled ? '1' : '0';
    if (b.retentionDays != null) {
      const d = Number(b.retentionDays);
      if (!Number.isInteger(d) || d < 0)
        return reply.code(400).send({ error: 'retentionDays must be an integer >= 0 (0 = off)' });
      patch.retention_days = String(d);
    }
    if (b.notifyInstances !== undefined) {
      if (!Array.isArray(b.notifyInstances) || !b.notifyInstances.every((n) => typeof n === 'string'))
        return reply.code(400).send({ error: 'notifyInstances must be an array of channel names' });
      const names = (b.notifyInstances as string[]).map((n) => n.trim()).filter(Boolean);
      if (!names.every((n) => SAFE_INSTANCE.test(n)))
        return reply.code(400).send({ error: 'notifyInstances has an invalid channel name' });
      patch.notify_instances = names.join(',');
    }

    // The saved apikey is sent wherever base points — make redirections loud.
    if (patch.evo_base != null && patch.evo_base !== cfg.evo.base)
      app.log.warn(`settings: Evolution base URL changed ${cfg.evo.base || '(empty)'} → ${patch.evo_base}`);
    store.set(patch);
    store.applyTo(cfg); // live: consumers read cfg by reference
    relay.reconfigure(cfg.evo);
    return publicSettings(cfg);
  });

  // Probe a candidate connection (unsaved values allowed) without persisting.
  app.post('/api/settings/test', { preHandler: requireAdmin }, async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const base = (typeof b.base === 'string' && b.base.trim() ? b.base.trim() : cfg.evo.base).replace(/\/+$/, '');
    const apikey = typeof b.apikey === 'string' && b.apikey.trim() ? b.apikey.trim() : cfg.evo.apikey;
    const instance =
      !cfg.evo.locked && typeof b.instance === 'string' && b.instance.trim() ? b.instance.trim() : cfg.evo.instance;
    if (!base) return { ok: false, error: 'Server URL is empty' };
    try {
      const scope = cfg.evo.locked && instance ? `?instanceName=${encodeURIComponent(instance)}` : '';
      const res = await fetch(`${base}/instance/fetchInstances${scope}`, {
        headers: { apikey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { ok: false, error: `Evolution returned ${res.status} ${res.statusText}` };
      const data = (await res.json().catch(() => [])) as unknown;
      const list = Array.isArray(data) ? data : [];
      const found = list.some((i: any) => (i?.name ?? i?.instance?.instanceName ?? i?.instanceName) === instance);
      return {
        ok: true,
        instances: list.length,
        instanceFound: found,
      };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  });
}
