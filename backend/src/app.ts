import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { registerAgents } from './routes/agents.js';
import { registerChats } from './routes/chats.js';
import { registerEvents } from './routes/events.js';
import { registerGateway } from './routes/gateway.js';
import { registerGroups } from './routes/groups.js';
import { registerInstances } from './routes/instances.js';
import { registerMaintenance } from './routes/maintenance.js';
import { registerProfile } from './routes/profile.js';
import { registerMeta } from './routes/meta.js';
import { registerPush } from './routes/push.js';
import { registerReminders } from './routes/reminders.js';
import { registerSending } from './routes/sending.js';
import { registerSettings } from './routes/settings.js';
import { registerStatic } from './routes/static.js';
import { AgentsStore, emailFromRequest } from './services/agents.js';
import { requirePerm, type PermissionKey } from './services/authz.js';
import { attachChatWatcher, ChatMetaStore } from './services/chatmeta.js';
import { EventRelay } from './services/events.js';
import { EvolutionClient, type EvolutionApi } from './services/evolution.js';
import { InstanceAccess, InstancesService } from './services/instances.js';
import { MaintenanceService } from './services/maintenance.js';
import { attachMessageCache, MessageCacheStore } from './services/msgcache.js';
import { attachChatUnread, ChatUnreadStore } from './services/chatunread.js';
import { attachReadTracker, ReadReceiptStore } from './services/readreceipts.js';
import { AgentPresence } from './services/presence.js';
import { NotifyPrefsStore } from './services/notifyprefs.js';
import { Housekeeping } from './services/housekeeping.js';
import { attachPushNotifier, PushService } from './services/push.js';
import { RemindersStore } from './services/reminders.js';
import { Sender } from './services/sender.js';
import { SettingsStore } from './services/settings.js';

export interface BuildOptions {
  cfg: Config;
  db: Db;
  /** Override for tests; defaults to a real Evolution client. */
  evo?: EvolutionApi;
  logger?: boolean;
}

export interface App {
  app: FastifyInstance;
  relay: EventRelay;
  /** Reminders + daily retention poll — started in index.ts, driven manually by tests. */
  housekeeping: Housekeeping;
}

export async function buildApp(opts: BuildOptions): Promise<App> {
  const { cfg, db } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 25 * 1024 * 1024, // base64 media can be large
  });

  const agents = new AgentsStore(db);
  const chatMeta = new ChatMetaStore(db);
  const reminders = new RemindersStore(db);
  const presence = new AgentPresence();
  const settings = new SettingsStore(db);
  // Saved operator settings override env config — applied before anything
  // captures cfg.evo so boot-time consumers (EventRelay) see the final values.
  settings.applyTo(cfg);
  const evo = opts.evo ?? new EvolutionClient(cfg.evo);
  const sender = new Sender(evo);
  // Multi-instance: per-agent grants + the cached safe view of fetchInstances
  const instanceAccess = new InstanceAccess(cfg, agents);
  const instancesService = new InstancesService(evo, () =>
    cfg.evo.locked && cfg.evo.instance ? cfg.evo.instance : null,
  );
  // not started here — index.ts starts it after listen (tests drive it manually)
  const relay = new EventRelay(
    { ...cfg.evo, enabled: cfg.eventsEnabled },
    (m) => app.log.info(m),
  );
  const maintenance = new MaintenanceService(db, cfg.dbPath, () => false, (m) => app.log.info(m));
  const emit = (event: string, data: unknown) => relay.broadcast({ event, data });
  const housekeeping = new Housekeeping({
    pollMs: cfg.pollMs,
    reminders,
    emit,
    // retention: cfg is read live, so the Settings field applies on the next day
    retentionSweep: () => {
      if (cfg.retentionDays > 0)
        maintenance.cleanup({ olderThanDays: cfg.retentionDays, gentle: true });
    },
    log: (m) => app.log.info(m),
  });
  // capture WHEN the recipient reads a sent message (the live ack is the only
  // carrier of the read time — see ReadReceiptStore)
  const readReceipts = new ReadReceiptStore(db);
  attachReadTracker(relay, (id) => readReceipts.markRead(id));
  // Snapshot message bodies as they arrive so a delete-for-everyone can still
  // show what it originally said (Evolution nulls the content on its side).
  const msgCache = new MessageCacheStore(db);
  attachMessageCache(relay, msgCache, (m) => app.log.info(m));
  // Shared, server-side unread badges: Evolution's findChats unreadCount is
  // unreliable here, so the relay tracks incoming-per-chat and the read/unread
  // endpoints move the shared cursor — every agent sees the same badge.
  const chatUnread = new ChatUnreadStore(db);
  attachChatUnread(relay, chatUnread, (jid) => chatMeta.canon(jid), (m) => app.log.info(m));
  const chatUnreadGw = {
    unreadFor: (inst: string, jid: string) => chatUnread.unreadFor(inst, chatMeta.canon(jid)),
    markRead: (inst: string, jid: string) => chatUnread.markRead(inst, chatMeta.canon(jid)),
    markUnread: (inst: string, jid: string) =>
      chatUnread.markUnread(inst, chatMeta.canon(jid), Date.now()),
  };
  attachChatWatcher(
    relay,
    chatMeta,
    (jid) => emit('CHAT_STATUS', { jid, status: 'open', by: '' }),
    (m) => app.log.info(m),
    () => cfg.evo.instance,
  );
  // Web Push: notifies a phone even when the app is closed (the in-page path
  // can't fire once the OS suspends the tab). Keyed by chat assignment like the
  // in-page notifier; which Evolution lines notify is operator-controlled
  // (Settings → Notifications), defaulting to the default line only.
  const push = new PushService(db, { subject: cfg.vapidSubject, log: (m) => app.log.info(m) });
  // Per-person notification preferences (group/DM mutes, quiet hours, keyword
  // alerts) layered on top of the global notifyInstances allowlist.
  const notifyPrefs = new NotifyPrefsStore(db);
  attachPushNotifier(
    relay,
    push,
    chatMeta,
    () => cfg.evo.instance,
    () => cfg.notifyInstances,
    notifyPrefs,
    (m) => app.log.info(m),
  );

  // Optional bearer-token auth for the API. Off when API_TOKEN is empty —
  // typical when an access proxy (e.g. Cloudflare Access) fronts the server.
  if (cfg.apiToken) {
    const tokenMatches = (candidate: string): boolean => {
      const a = Buffer.from(candidate);
      const b = Buffer.from(cfg.apiToken);
      return a.length === b.length && timingSafeEqual(a, b);
    };
    app.addHook('onRequest', async (req, reply) => {
      const path = (req.raw.url ?? '').split('?')[0]!;
      if (!path.startsWith('/api/') || path === '/api/health') return;
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      // ?token= because EventSource (SSE) cannot set request headers — accepted
      // only on /api/events so tokens stay out of access logs elsewhere
      const query =
        path === '/api/events'
          ? (req.query as Record<string, unknown> | undefined)?.token
          : undefined;
      const token =
        (req.headers['x-api-token'] as string | undefined) ??
        (typeof query === 'string' && query ? query : bearer);
      if (!tokenMatches(token)) return reply.code(401).send({ error: 'unauthorized' });
    });
  }

  // Agent identification (Settings toggle): auto-provision the agent and bump
  // last_seen from the Cloudflare Access identity header on every API request.
  app.addHook('onRequest', async (req) => {
    if (!cfg.agentsEnabled) return;
    if (!(req.raw.url ?? '').startsWith('/api/')) return;
    const email = emailFromRequest(req);
    if (email) agents.seen(email);
  });

  // Role-based access (admin vs agent), enforced per route on top of the
  // identity the provision hook above just recorded.
  const guard = (key: PermissionKey) => requirePerm(key, { cfg, agents });

  registerMeta(app);
  registerSending(app, sender, cfg, agents, chatMeta, instanceAccess);
  registerAgents(app, agents, cfg, guard('agents.manage'), { meta: chatMeta, emit, access: instanceAccess });
  registerChats(app, { cfg, meta: chatMeta, agents, presence, emit });
  registerReminders(app, { cfg, agents, reminders });
  registerPush(app, { cfg, push, prefs: notifyPrefs });
  registerInstances(app, {
    cfg,
    agents,
    access: instanceAccess,
    instances: instancesService,
    evo,
    requireAdmin: guard('settings.manage'),
  });
  registerMaintenance(app, {
    cfg,
    maintenance,
    instances: instancesService,
    access: instanceAccess,
    requireViewer: guard('settings.manage'),
    requireAdmin: guard('settings.manage'),
  });
  registerGateway(
    app,
    evo,
    instanceAccess,
    msgCache,
    (messageId, req, chatJid) => {
      // remember which agent deleted a message for everyone (Settings toggle)
      if (!cfg.agentsEnabled) return;
      const email = emailFromRequest(req);
      if (email) agents.recordDelete(messageId, email, chatMeta.canon(chatJid) ?? chatJid);
    },
    (messageId, req, chatJid) => {
      // remember which agent edited a message (Settings toggle)
      if (!cfg.agentsEnabled) return;
      const email = emailFromRequest(req);
      if (email) agents.recordEdit(messageId, email, chatMeta.canon(chatJid) ?? chatJid);
    },
    readReceipts,
    chatUnreadGw,
    emit,
    (rawInstance, jid, altJid) => {
      // Learn lid↔phone aliases from opened threads — but only the default
      // instance, mirroring attachChatWatcher (chat meta is jid-keyed app-wide,
      // and a reconnecting secondary instance replays history).
      if (rawInstance === cfg.evo.instance) chatMeta.learnAlias(jid, altJid);
    },
  );
  registerGroups(app, evo, instanceAccess);
  registerProfile(app, evo, instanceAccess);
  registerEvents(app, relay, instanceAccess);
  registerSettings(app, { cfg, store: settings, relay, requireAdmin: guard('settings.manage') });
  await registerStatic(app, cfg);

  app.addHook('onClose', async () => {
    housekeeping.stop();
    relay.stop();
  });

  return { app, relay, housekeeping };
}
