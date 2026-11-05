import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ChatMeta, EvoChat, Me } from '../types';
import { api } from './api';
import { isLooking, isOpenChat } from './attention';
import {
  applyLiveMessages,
  applyLiveToChats,
  displayNumber,
  parseMessage,
  type ChatMsg,
  type ThreadFetchResult,
} from './chatModel';
import { onBusReconnect, useBusEvent } from './eventBus';
import { getActiveInstance } from './instance';
import { messageGate, notifyMessage } from './notify';
import { playChime } from './sound';

/** Presence per jid: 'composing' | 'recording' | 'available' | ... */
export type PresenceMap = Record<string, string>;

const UPSERT_EVENTS = ['MESSAGES_UPSERT', 'messages.upsert'] as const;
const UPDATE_EVENTS = ['MESSAGES_UPDATE', 'messages.update'] as const;
// CHAT_READ is our own app event — another agent read/unread a chat, so the
// shared unread badge changed; refetch the list to pick it up.
const CHAT_EVENTS = ['CHATS_UPSERT', 'chats.upsert', 'CHATS_UPDATE', 'chats.update', 'CHAT_READ'] as const;
const PRESENCE_EVENTS = ['PRESENCE_UPDATE', 'presence.update'] as const;
const PRESENCE_TTL_MS = 10_000;
/** Background reconcile after a live insert — picks up media URLs, acks, enrichments. */
const RECONCILE_MS = 1_500;
/**
 * A message older than this when its event arrives is a history replay
 * (Evolution re-syncs on reconnect) — it updates the caches but never pings.
 */
const STALE_NOTIFY_MS = 5 * 60_000;
// Chat-list refreshes are throttled. `/api/chats` proxies Evolution's most
// expensive query (findChats), and an event burst — a busy group, a campaign's
// acks — used to fire one invalidation per event. Because an invalidation
// cancels the running fetch without aborting its HTTP request, every one of
// them opened ANOTHER /api/chats round-trip on top of the ones still in flight:
// in prod one slow upstream became eight concurrent calls from a single tab.
// At most one refresh per window now, and never a second while one is running.
const CHATS_REFRESH_MS = 3_000;

/**
 * Throttle state per query client — module-level so every caller shares ONE
 * window. Two components throttling separately would just stack their bursts,
 * which is the bug this exists to prevent. Keyed by client (a WeakMap, so a
 * discarded client's state goes with it) rather than held in a ref, since the
 * callers are in different components.
 */
const chatsThrottle = new WeakMap<QueryClient, { timer: ReturnType<typeof setTimeout> | null; pending: boolean }>();

/**
 * Refresh the chat list, coalescing bursts. A fetch already running may have
 * started before the change that prompted this call, so it can't stand in for
 * it — we mark the refresh pending and let the window's trailing edge issue it
 * once the line is free, instead of stacking a second concurrent request.
 *
 * Every event- or message-driven chat-list refresh must go through here. A
 * direct `invalidateQueries({queryKey:['chats']})` re-opens the storm: it
 * defaults to cancelRefetch, which abandons the in-flight fetch's promise
 * WITHOUT aborting its HTTP request, so each one adds a concurrent
 * /api/chats round-trip. Explicit one-shot user actions (archive, mark
 * unread) are bounded by the click and may still invalidate directly.
 */
export function refreshChats(qc: QueryClient): void {
  let state = chatsThrottle.get(qc);
  if (!state) {
    state = { timer: null, pending: false };
    chatsThrottle.set(qc, state);
  }
  const s = state;
  if (s.timer) {
    s.pending = true;
    return;
  }
  if (qc.getQueryState(['chats'])?.fetchStatus === 'fetching') s.pending = true;
  else void qc.invalidateQueries({ queryKey: ['chats'] }, { cancelRefetch: false });
  s.timer = setTimeout(() => {
    s.timer = null;
    if (s.pending) {
      s.pending = false;
      refreshChats(qc);
    }
  }, CHATS_REFRESH_MS);
}

/**
 * Evolution's envelope ({instance, data}) → record list. Mirrors the
 * backend's unwrapEvent incl. the {messages:[…]} upsert variant.
 */
function unwrapClient(data: any): { instance?: string; records: any[] } {
  const instance = typeof data?.instance === 'string' ? data.instance : undefined;
  const payload = instance !== undefined && data && typeof data === 'object' && 'data' in data ? data.data : data;
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.messages)
      ? payload.messages
      : payload == null
        ? []
        : [payload];
  return { instance, records };
}

function extractJid(data: any): string {
  return (
    data?.key?.remoteJid ??
    data?.remoteJid ??
    data?.id ??
    (data?.presences ? Object.keys(data.presences)[0] : '') ??
    ''
  );
}

function extractPresence(data: any): string {
  if (data?.presences) {
    const first = Object.values(data.presences)[0] as any;
    return first?.lastKnownPresence ?? '';
  }
  return data?.presence ?? data?.lastKnownPresence ?? '';
}

/** Events from another instance — the server filters for restricted agents, but admins get the firehose. */
function isForeign(qc: QueryClient, instance: string | undefined): boolean {
  if (instance === undefined) return false;
  const eff = getActiveInstance() || qc.getQueryData<Me>(['me'])?.defaultInstance || '';
  return !!eff && instance !== eff;
}

/** Whether a parsed live message is something a person would want pinged about. */
function isPingable(msg: ChatMsg): boolean {
  // a delete-for-everyone parses to a real (content-nulled) bubble, not a
  // dropped record — it must not masquerade as a new incoming message
  return (
    !msg.fromMe &&
    !msg.deletedBySender &&
    msg.type !== 'reaction' &&
    msg.type !== 'edit' &&
    msg.type !== 'delete' &&
    Date.now() - msg.timestamp * 1000 < STALE_NOTIFY_MS
  );
}

/** An incoming message that should reach the agent (before their personal prefs gate). */
export interface LivePing {
  msg: ChatMsg;
  /** canonical chat jid — the notification tag and click target */
  canon: string;
}

/**
 * Handle one MESSAGES_UPSERT event (Evolution's {instance, data} envelope):
 * write its messages into every cached thread they belong to and bump their
 * chat-list rows, then return the ones worth pinging about. Pure apart from
 * the query cache — no sound, no notification — so it can be tested against a
 * real QueryClient with the production envelope shape.
 */
export function ingestUpsert(qc: QueryClient, data: unknown): LivePing[] {
  const { instance, records } = unwrapClient(data);
  if (isForeign(qc, instance)) return [];
  const live = records
    .map((raw) => ({ raw, msg: raw ? parseMessage(raw) : null }))
    .filter((x): x is { raw: any; msg: ChatMsg } => !!x.msg);
  const altOf = (raw: any): string => (typeof raw?.key?.remoteJidAlt === 'string' ? raw.key.remoteJidAlt : '');
  const onScreen = (raw: any, msg: ChatMsg) =>
    isLooking() && (isOpenChat(msg.remoteJid) || isOpenChat(altOf(raw)));

  // 1. cached threads: insert now. Records live under @lid or phone jids
  // interchangeably, so match against every jid the thread spans (key[2]).
  for (const [key, thread] of qc.getQueriesData<ThreadFetchResult>({ queryKey: ['messages'] })) {
    if (!thread) continue;
    const span = String(key[2] ?? '').split(',');
    const mine = live.filter(({ raw, msg }) => span.includes(msg.remoteJid) || span.includes(altOf(raw)));
    if (!mine.length) continue;
    const next = applyLiveMessages(
      thread,
      mine.map((x) => x.msg),
    );
    if (next !== thread) qc.setQueryData(key, next);
  }

  // 2. chat list: bump the row now; the throttled refetch reconciles (and is
  // the only way a brand-new conversation appears).
  for (const { raw, msg } of live) {
    if (msg.type === 'reaction' || msg.type === 'edit' || msg.type === 'delete') continue;
    const chats = qc.getQueryData<EvoChat[]>(['chats']);
    if (!Array.isArray(chats)) break;
    const next = applyLiveToChats(chats, raw, { countUnread: !onScreen(raw, msg) });
    if (next && next !== chats) qc.setQueryData(['chats'], next);
  }

  // 3. who to ping. Already on screen → nobody. Chats assigned to ANOTHER
  // agent stay quiet for me — the assignee gets the ping; unassigned chats
  // keep notifying everyone.
  const meta = qc.getQueryData<ChatMeta>(['chat-meta']);
  const me = qc.getQueryData<Me>(['me']);
  const pings: LivePing[] = [];
  for (const { raw, msg } of live) {
    if (!isPingable(msg) || onScreen(raw, msg)) continue;
    const canon = meta?.aliases[msg.remoteJid] ?? msg.remoteJid;
    const assignee = meta?.assignments[canon]?.agentEmail;
    if (assignee && me?.enabled && me.email && assignee !== me.email) continue;
    pings.push({ msg, canon });
  }
  return pings;
}

/**
 * The app-wide live inbox, mounted once in App so it runs on every tab (it
 * used to live inside the Chat page — on any other tab nothing listened, so no
 * notification ever fired and the list went stale).
 *
 * A new message is written straight into the open thread's cache and the chat
 * list the moment its event lands, then reconciled with a debounced refetch —
 * instead of waiting on a findMessages / findChats round-trip before anything
 * shows. Then: already looking at that chat → nothing; app in front on another
 * chat → chime; app in the background / unfocused → chime + system notification.
 */
export function useLiveInbox(): void {
  const qc = useQueryClient();
  // This person's notification prefs — the in-page gate honors them (group/DM
  // mute, quiet hours, keyword alerts) the same way the server's push path
  // does. Until loaded, the gate falls back to "notify".
  const notifyPrefs = useQuery({ queryKey: ['notifyPrefs'], queryFn: api.notifyPrefs.get, staleTime: 300_000 });
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reconcileThreads = () => {
    if (reconcileTimer.current) return;
    reconcileTimer.current = setTimeout(() => {
      reconcileTimer.current = null;
      void qc.invalidateQueries({ queryKey: ['messages'] }, { cancelRefetch: false });
    }, RECONCILE_MS);
  };
  useEffect(() => () => {
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
  }, []);

  // Events missed while the stream was down are gone for good — refetch.
  useEffect(
    () =>
      onBusReconnect(() => {
        refreshChats(qc);
        void qc.invalidateQueries({ queryKey: ['messages'] }, { cancelRefetch: false });
      }),
    [qc],
  );

  useBusEvent(UPSERT_EVENTS, (data: unknown) => {
    const pings = ingestUpsert(qc, data);
    reconcileThreads();
    refreshChats(qc);
    for (const { msg, canon } of pings) {
      const isGroup = msg.remoteJid.endsWith('@g.us');
      if (!messageGate(notifyPrefs.data, { isGroup, text: msg.text || msg.caption || '' })) continue;
      const chimed = playChime();
      const who = msg.pushName || displayNumber(msg.senderJid || msg.remoteJid);
      const preview = msg.text || msg.caption || (msg.hasMedia ? `📎 ${msg.type}` : msg.type);
      // click opens this conversation, scrolled to this message (mirrors the
      // server push url so in-page and push notifications behave the same)
      const url =
        `/?chat=${encodeURIComponent(msg.remoteJid)}` +
        (msg.id ? `&msg=${encodeURIComponent(msg.id)}` : '');
      // tag = canonical jid, the same tag the server's Web Push uses, so the
      // two collapse into one notification instead of stacking
      notifyMessage(who, preview.slice(0, 140), canon, url, { silent: chimed });
    }
  });

  // acks / status changes: no new rows, just reconcile soon
  useBusEvent(UPDATE_EVENTS, (data: any) => {
    if (isForeign(qc, unwrapClient(data).instance)) return;
    reconcileThreads();
    refreshChats(qc);
  });

  useBusEvent(CHAT_EVENTS, (data: any) => {
    if (isForeign(qc, unwrapClient(data).instance)) return;
    refreshChats(qc);
  });
}

/**
 * Typing / recording presence per chat, short-lived (cleared after
 * PRESENCE_TTL_MS without a refresh). Used by the Chat page only.
 */
export function usePresence(): PresenceMap {
  const qc = useQueryClient();
  const [presence, setPresence] = useState<PresenceMap>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useBusEvent(PRESENCE_EVENTS, (data: any) => {
    if (isForeign(qc, unwrapClient(data).instance)) return;
    const payload = data?.data ?? data;
    const jid = extractJid(payload);
    const state = extractPresence(payload);
    if (!jid || !state) return;
    setPresence((p) => ({ ...p, [jid]: state }));
    clearTimeout(timers.current[jid]);
    timers.current[jid] = setTimeout(
      () =>
        setPresence((p) => {
          const { [jid]: _gone, ...rest } = p;
          return rest;
        }),
      PRESENCE_TTL_MS,
    );
  });

  return presence;
}
