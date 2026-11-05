import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setOpenChat } from '../src/lib/attention';
import type { ThreadFetchResult } from '../src/lib/chatModel';
import { ingestUpsert } from '../src/lib/useEvents';

const now = () => Math.floor(Date.now() / 1000);
const PHONE = '972521111111@s.whatsapp.net';
const LID = '555000111@lid';
const THREAD_KEY = ['messages', PHONE, [LID, PHONE].sort().join(','), 1];

/**
 * Evolution's GLOBAL websocket wraps every payload as {event, instance, data}
 * — the same shape the backend relays verbatim over SSE. A listener that only
 * handles a bare record silently no-ops in production (see tasks/lessons.md),
 * so these tests feed the production shape.
 */
const envelope = (data: unknown, instance = 'Test') => ({
  event: 'messages.upsert',
  instance,
  data,
  server_url: 'https://evo.example',
  date_time: new Date().toISOString(),
});

const incoming = (id: string, text: string, key: Record<string, unknown> = {}) => ({
  key: { remoteJid: PHONE, fromMe: false, id, ...key },
  pushName: 'Dana',
  message: { conversation: text },
  messageTimestamp: now(),
});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient();
  qc.setQueryData(['me'], { enabled: false, email: null, defaultInstance: 'Test' });
  qc.setQueryData<ThreadFetchResult>(THREAD_KEY, { records: [], hasMore: false });
  qc.setQueryData(['chats'], [{ remoteJid: PHONE, unreadCount: 0, lastMsgTimestamp: 0 }]);
});
afterEach(() => {
  setOpenChat(null);
  delete (globalThis as { document?: unknown }).document;
});

describe('ingestUpsert (live MESSAGES_UPSERT → caches + pings)', () => {
  it('writes an enveloped message into the open thread and bumps its chat row', () => {
    const pings = ingestUpsert(qc, envelope(incoming('M1', 'hello')));
    const thread = qc.getQueryData<ThreadFetchResult>(THREAD_KEY)!;
    expect(thread.records.map((m) => m.text)).toEqual(['hello']);
    const [row] = qc.getQueryData<any[]>(['chats'])!;
    expect(row.unreadCount).toBe(1);
    expect(row.lastMessage.message.conversation).toBe('hello');
    expect(pings.map((p) => p.msg.id)).toEqual(['M1']);
  });

  it('routes a @lid-addressed message into the thread that spans that lid', () => {
    ingestUpsert(qc, envelope(incoming('M2', 'via lid', { remoteJid: LID })));
    expect(qc.getQueryData<ThreadFetchResult>(THREAD_KEY)!.records.map((m) => m.id)).toEqual(['M2']);
  });

  it('handles the {messages:[…]} batch variant', () => {
    ingestUpsert(qc, envelope({ messages: [incoming('A', 'one'), incoming('B', 'two')] }));
    expect(qc.getQueryData<ThreadFetchResult>(THREAD_KEY)!.records).toHaveLength(2);
  });

  it('ignores another instance entirely', () => {
    const pings = ingestUpsert(qc, envelope(incoming('X', 'not mine'), 'OtherLine'));
    expect(pings).toEqual([]);
    expect(qc.getQueryData<ThreadFetchResult>(THREAD_KEY)!.records).toEqual([]);
  });

  it('does not ping for own messages or history replays, but still caches them', () => {
    const old = { ...incoming('OLD', 'from last week'), messageTimestamp: now() - 7 * 86_400 };
    const pings = ingestUpsert(qc, envelope({ messages: [incoming('ME', 'sent from phone', { fromMe: true }), old] }));
    expect(pings).toEqual([]);
    expect(qc.getQueryData<ThreadFetchResult>(THREAD_KEY)!.records).toHaveLength(2);
  });

  it('stays silent and does not count unread for the chat on screen', () => {
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', hasFocus: () => true };
    setOpenChat([PHONE, LID]);
    const pings = ingestUpsert(qc, envelope(incoming('M3', 'while looking')));
    expect(pings).toEqual([]);
    expect(qc.getQueryData<any[]>(['chats'])![0].unreadCount).toBe(0);
    // ...but the same chat open in a background tab still pings
    (globalThis as { document?: unknown }).document = { visibilityState: 'hidden', hasFocus: () => false };
    expect(ingestUpsert(qc, envelope(incoming('M4', 'tab hidden')))).toHaveLength(1);
  });

  it('leaves a chat assigned to someone else quiet for me', () => {
    qc.setQueryData(['me'], { enabled: true, email: 'me@x.com', defaultInstance: 'Test' });
    qc.setQueryData(['chat-meta'], {
      aliases: {},
      assignments: { [PHONE]: { agentEmail: 'other@x.com' } },
    });
    expect(ingestUpsert(qc, envelope(incoming('M5', 'for other')))).toEqual([]);
  });
});
