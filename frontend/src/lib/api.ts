import type {
  Agent,
  AgentRole,
  ChatMeta,
  ChatNote,
  ChatWorkStatus,
  CleanupResult,
  EvoChat,
  InstanceInfo,
  MaintenanceReport,
  Me,
  MessageAgents,
  MessageItem,
  Perms,
  Reminder,
  SendResult,
} from '../types';
import { withInstance } from './instance';

const DEFAULT_TIMEOUT_MS = 25_000;

/** Thrown when a request is aborted by the client-side timeout (never by a server error). */
export class TimeoutError extends Error {
  readonly timedOut = true as const;
  constructor(msg = 'The request timed out') {
    super(msg);
    this.name = 'TimeoutError';
  }
}

type HttpInit = RequestInit & { timeoutMs?: number };

async function http<T>(path: string, init?: HttpInit): Promise<T> {
  // Content-Type only when a body is actually sent — Fastify 400s on
  // "application/json" with an empty body (bodyless DELETEs broke on this).
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init?.body != null) headers['Content-Type'] = 'application/json';
  // AbortController timeout: a hung request must always settle, so a send can
  // never stay outstanding forever (which used to lock the composer). The
  // `timedOut` flag distinguishes a timeout-driven abort from a coincidental
  // post-abort reject, and we capture `res` before parsing so a slow body
  // parse of a 200 is never relabeled a timeout.
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { ...rest, headers, signal: ac.signal });
  } catch (e) {
    if (timedOut) throw new TimeoutError('The request timed out — check your connection');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const get = <T,>(path: string) => http<T>(path);
const post = <T,>(path: string, body?: unknown, opts?: { timeoutMs?: number }) =>
  http<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), ...opts });
const put = <T,>(path: string, body: unknown) =>
  http<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = <T,>(path: string) => http<T>(path, { method: 'DELETE' });

// Endpoints scoped to the ACTIVE instance (header switcher) append `?instance=`:
// the Evolution-backed calls. The rest (chat-meta, reminders, agents) stays
// instance-free.
const iget = <T,>(path: string) => http<T>(withInstance(path));
const ipost = <T,>(path: string, body?: unknown, opts?: { timeoutMs?: number }) =>
  http<T>(withInstance(path), { method: 'POST', body: JSON.stringify(body ?? {}), ...opts });
const iput = <T,>(path: string, body: unknown) =>
  http<T>(withInstance(path), { method: 'PUT', body: JSON.stringify(body) });
const idel = <T,>(path: string) => http<T>(withInstance(path), { method: 'DELETE' });

export interface ServerSettings {
  base: string;
  instance: string;
  /** EVOLUTION_LOCK_INSTANCE — the channel comes from the env and can't change. */
  instanceLocked?: boolean;
  apikeySet: boolean;
  apikeyHint: string;
  /** The zone the server reads 'HH:MM' values in, plus its clock. */
  timezone: string;
  serverTime: string;
  agentsEnabled: boolean;
  retentionDays: number;
  /** Evolution lines whose incoming messages notify ([] = none). */
  notifyInstances: string[];
}

export type SettingsPatch = Partial<
  Omit<ServerSettings, 'apikeySet' | 'apikeyHint' | 'timezone' | 'serverTime'> & { apikey: string }
>;

/** Per-person notification preferences (each agent sets their own). */
export interface NotifyPrefs {
  groups: boolean;
  dms: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  keywords: string;
}

export const api = {
  health: () => get<{ ok: boolean; mode: string; version: string }>('/api/health'),

  settings: {
    get: () => get<ServerSettings>('/api/settings'),
    save: (patch: SettingsPatch) => put<ServerSettings>('/api/settings', patch),
    test: (candidate: { base?: string; instance?: string; apikey?: string }) =>
      post<{ ok: boolean; instances?: number; instanceFound?: boolean; error?: string }>(
        '/api/settings/test',
        candidate,
      ),
  },

  notifyPrefs: {
    get: () => get<NotifyPrefs>('/api/notify-prefs'),
    save: (patch: Partial<NotifyPrefs>) => put<NotifyPrefs>('/api/notify-prefs', patch),
  },

  push: {
    // endpoint targets this device exactly; the server falls back to the
    // caller's identity when it's absent.
    test: (endpoint?: string) =>
      post<{ sent: number }>('/api/push/test', endpoint ? { endpoint } : {}),
  },

  me: () => get<Me>('/api/me'),

  agents: {
    list: () => get<Agent[]>('/api/agents'),
    update: (
      email: string,
      patch: {
        name?: string;
        color?: string;
        active?: boolean;
        role?: AgentRole;
        perms?: Partial<Perms>;
        instances?: string[] | null;
      },
    ) => put<Agent>(`/api/agents/${encodeURIComponent(email)}`, patch),
  },

  instances: {
    list: () => get<{ default: string; locked?: boolean; instances: InstanceInfo[] }>('/api/instances'),
    create: (name: string) =>
      post<{ name: string; base64: string | null; pairingCode: string | null }>('/api/instances', { name }),
    remove: (name: string) => del<{ ok: boolean }>(`/api/instances/${encodeURIComponent(name)}`),
    qr: (name: string) =>
      get<{ connected: boolean; base64: string | null; pairingCode: string | null }>(
        `/api/instances/${encodeURIComponent(name)}/qr`,
      ),
    state: (name: string) => get<{ state: string }>(`/api/instances/${encodeURIComponent(name)}/state`),
  },

  maintenance: {
    get: () => get<MaintenanceReport>('/api/maintenance'),
    cleanup: (olderThanDays: number, opts: { dryRun?: boolean; vacuum?: boolean } = {}) =>
      post<CleanupResult>('/api/maintenance/cleanup', { olderThanDays, ...opts }),
  },

  chatMeta: {
    get: () => get<ChatMeta>('/api/chat-meta'),
    syncAliases: (pairs: Array<[string, string]>) =>
      post<{ ok: boolean; learned: number; aliases: Record<string, string> }>('/api/chat-aliases', { pairs }),
    assign: (jid: string, agentEmail: string | null) =>
      post<{ ok: boolean; jid: string }>('/api/chats/assign', { jid, agentEmail }),
    setStatus: (jid: string, status: ChatWorkStatus) =>
      post<{ ok: boolean; jid: string }>('/api/chats/status', { jid, status }),
    setTags: (jid: string, tags: string[]) =>
      post<{ ok: boolean; jid: string; tags: string[] }>('/api/chats/tags', { jid, tags }),
    notes: (jid: string) => get<ChatNote[]>(`/api/chats/notes?jid=${encodeURIComponent(jid)}`),
    addNote: (jid: string, body: string) => post<ChatNote>('/api/chats/notes', { jid, body }),
    removeNote: (id: number) => del<{ ok: boolean }>(`/api/chats/notes/${id}`),
  },

  agentPresence: (tabId: string, chatJid: string, typing: boolean) =>
    post<{ ok: boolean }>('/api/agent-presence', { tabId, chatJid, typing }),

  reminders: {
    list: () => get<Reminder[]>('/api/reminders'),
    create: (chatJid: string, dueAt: string, note: string) =>
      post<Reminder>('/api/reminders', { chatJid, dueAt, note }),
    dismiss: (id: number) => post<Reminder>(`/api/reminders/${id}/dismiss`),
    remove: (id: number) => del<{ ok: boolean }>(`/api/reminders/${id}`),
  },

  messageAgents: (ids: string[]) => post<MessageAgents>('/api/message-agents', { ids }),

  send: (recipient: string, item: MessageItem, isGroup = false) =>
    ipost<SendResult>(
      '/api/send',
      { recipient, item, isGroup },
      // media/voice carry large base64 uploads that legitimately exceed 25s
      { timeoutMs: item.type === 'media' || item.type === 'voice' ? 60_000 : 25_000 },
    ),

  chats: {
    list: () => iget<EvoChat[]>('/api/chats'),
    contacts: () => iget<EvoChat[]>('/api/contacts'),
    groups: () => iget<EvoChat[]>('/api/groups'),
    messages: (remoteJid: string, page = 1) =>
      ipost<unknown>('/api/messages/find', { remoteJid, page }),
    markRead: (readMessages: Array<{ remoteJid: string; fromMe: boolean; id: string }>) =>
      ipost<unknown>('/api/chats/read', { readMessages }),
    // List-level mark-as-read: no message ids in hand, just clear the shared badge.
    markChatRead: (chat: string) => ipost<unknown>('/api/chats/read', { chat }),
    markUnread: (chat: string, lastMessage?: unknown) =>
      ipost<unknown>('/api/chats/unread', { chat, lastMessage }),
    archive: (chat: string, archive = true) => ipost<unknown>('/api/chats/archive', { chat, archive }),
    block: (number: string, status: 'block' | 'unblock') =>
      ipost<unknown>('/api/contacts/block', { number, status }),
  },

  messages: {
    edit: (remoteJid: string, messageId: string, text: string) =>
      ipost<unknown>('/api/messages/edit', { remoteJid, messageId, text }),
    delete: (remoteJid: string, messageId: string, fromMe = true, participant?: string) =>
      ipost<unknown>('/api/messages/delete', {
        remoteJid,
        messageId,
        fromMe,
        ...(participant ? { participant } : {}),
      }),
  },

  groups: {
    create: (subject: string, participants: string[], description?: string) =>
      ipost<Record<string, any>>('/api/groups/create', { subject, participants, description }),
    info: (jid: string) => iget<Record<string, any>>(`/api/groups/info?jid=${encodeURIComponent(jid)}`),
    participants: (jid: string, action: 'add' | 'remove' | 'promote' | 'demote', participants: string[]) =>
      ipost<unknown>('/api/groups/participants', { jid, action, participants }),
    subject: (jid: string, subject: string) => ipost<unknown>('/api/groups/subject', { jid, subject }),
    description: (jid: string, description: string) =>
      ipost<unknown>('/api/groups/description', { jid, description }),
    picture: (jid: string, image: string) => ipost<unknown>('/api/groups/picture', { jid, image }),
    setting: (jid: string, action: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') =>
      ipost<unknown>('/api/groups/setting', { jid, action }),
    ephemeral: (jid: string, expiration: number) =>
      ipost<unknown>('/api/groups/ephemeral', { jid, expiration }),
    invite: (jid: string) => iget<Record<string, any>>(`/api/groups/invite?jid=${encodeURIComponent(jid)}`),
    revokeInvite: (jid: string) => ipost<Record<string, any>>('/api/groups/invite/revoke', { jid }),
    leave: (jid: string) => ipost<unknown>('/api/groups/leave', { jid }),
  },

  profile: {
    fetch: () => iget<Record<string, any>>('/api/profile'),
    setName: (name: string) => iput<unknown>('/api/profile/name', { name }),
    setStatus: (status: string) => iput<unknown>('/api/profile/status', { status }),
    setPicture: (picture: string) => iput<unknown>('/api/profile/picture', { picture }),
    removePicture: () => idel<unknown>('/api/profile/picture'),
    privacy: () => iget<Record<string, any>>('/api/profile/privacy'),
    setPrivacy: (privacy: Record<string, string>) => iput<unknown>('/api/profile/privacy', privacy),
  },

  media: (message: { key: { id: string; remoteJid: string; fromMe: boolean } }) =>
    ipost<Record<string, any>>('/api/media', { message }),

  presence: (number: string, presence: string, delay?: number) =>
    ipost<unknown>('/api/presence', { number, presence, delay }),
};
