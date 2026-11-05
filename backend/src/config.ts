import path from 'node:path';

export interface EvolutionConfig {
  base: string;
  instance: string;
  apikey: string;
  /**
   * Cap the whole server to `instance`: Evolution calls that target any other
   * instance are refused before they leave the process, other instances'
   * websocket events are dropped, and the channel can't be changed or added
   * from the UI. EVOLUTION_LOCK_INSTANCE=false restores multi-channel mode.
   */
  locked: boolean;
}

export interface Config {
  port: number;
  staticDir: string;
  dbPath: string;
  /** Empty string = API auth disabled (rely on an access proxy in front). */
  apiToken: string;
  /** Housekeeping poll (due reminders, daily retention sweep). */
  pollMs: number;
  /** Relay Evolution websocket events to clients over SSE (/api/events). */
  eventsEnabled: boolean;
  /** Agent identification: tag sends with the Cloudflare Access user (Settings toggle). */
  agentsEnabled: boolean;
  /** Auto-purge attribution/cache rows older than this many days. 0 = off. */
  retentionDays: number;
  /** VAPID "sub" claim for Web Push — a mailto: or https: contact. */
  vapidSubject: string;
  /**
   * Evolution lines whose incoming messages fire a push notification — the
   * complete allowlist, the default line included. Empty = no notifications
   * (Settings → Notifications controls this; nothing is implicit).
   */
  notifyInstances: string[];
  evo: EvolutionConfig;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config: ${key}=${JSON.stringify(raw)} is not a number`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    port: num(env, 'PORT', 8080),
    staticDir: path.resolve(env.STATIC_DIR || '../frontend/dist'),
    dbPath: env.DB_PATH || './data/webchat.db',
    apiToken: env.API_TOKEN || '',
    pollMs: Math.max(1000, num(env, 'POLL_MS', 15000)),
    eventsEnabled: env.EVENTS_ENABLED !== 'false',
    agentsEnabled: env.AGENTS_ENABLED === 'true',
    retentionDays: Math.max(0, num(env, 'RETENTION_DAYS', 0)),
    vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@webchat.local',
    notifyInstances: (env.NOTIFY_INSTANCES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    evo: {
      base: (env.EVOLUTION_BASE || '').replace(/\/+$/, ''),
      instance: env.EVOLUTION_INSTANCE || '',
      apikey: env.EVOLUTION_APIKEY || '',
      locked: env.EVOLUTION_LOCK_INSTANCE !== 'false',
    },
  };
}
