import { describe, expect, it } from 'vitest';
import {
  applyLiveMessages,
  applyLiveToChats,
  fetchThread,
  mergeThreadRecords,
  parseMessage,
  type ChatMsg,
  type ThreadFetchResult,
} from '../src/lib/chatModel';

const SECS = 1_718_200_000;
const PHONE = '972520000000@s.whatsapp.net';
const LID = '123456789@lid';

const msg = (id: string, text: string, over: Partial<ChatMsg> = {}): ChatMsg => ({
  id,
  remoteJid: PHONE,
  fromMe: false,
  timestamp: SECS,
  type: 'text',
  text,
  caption: '',
  mimetype: '',
  fileName: '',
  hasMedia: false,
  quoted: null,
  status: '',
  edited: false,
  pushName: '',
  senderJid: '',
  reactionTargetId: '',
  editTargetId: '',
  editHistory: [],
  deletedBySender: false,
  ...over,
});

const thread = (...records: ChatMsg[]): ThreadFetchResult => ({ records, hasMore: false });

describe('applyLiveMessages (write live events straight into a thread)', () => {
  it('appends a new message in timestamp order', () => {
    const prev = thread(msg('A', 'one', { timestamp: SECS }), msg('C', 'three', { timestamp: SECS + 20 }));
    const out = applyLiveMessages(prev, [msg('B', 'two', { timestamp: SECS + 10 })]);
    expect(out.records.map((m) => m.id)).toEqual(['A', 'B', 'C']);
    expect(prev.records.map((m) => m.id)).toEqual(['A', 'C']); // never mutates the cache entry
  });

  it('returns the same object when nothing changed (no needless re-render)', () => {
    const prev = thread(msg('A', 'one'));
    expect(applyLiveMessages(prev, [msg('A', 'one, again')])).toBe(prev);
    expect(applyLiveMessages(prev, [])).toBe(prev);
  });

  it('keeps the server copy when an id is already present', () => {
    const prev = thread(msg('A', 'one', { readAt: 123 }));
    const out = applyLiveMessages(prev, [msg('A', 'one')]);
    expect(out.records[0]!.readAt).toBe(123);
  });

  it('folds an edit onto its target and records the previous text', () => {
    const prev = thread(msg('A', 'old'));
    const out = applyLiveMessages(prev, [
      msg('e1', 'new', { type: 'edit', editTargetId: 'A', timestamp: SECS + 5 }),
    ]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({ id: 'A', text: 'new', edited: true, editHistory: ['old'] });
  });

  it('flags a delete-for-everyone on its target', () => {
    const out = applyLiveMessages(thread(msg('A', 'hi')), [
      msg('d1', '', { type: 'delete', editTargetId: 'A' }),
    ]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.deletedBySender).toBe(true);
  });

  it('drops control records whose target is not loaded (the refetch handles them)', () => {
    const prev = thread(msg('A', 'hi'));
    const out = applyLiveMessages(prev, [
      msg('e1', 'x', { type: 'edit', editTargetId: 'GONE' }),
      msg('d1', '', { type: 'delete', editTargetId: 'GONE' }),
    ]);
    expect(out).toBe(prev);
  });

  it('adds reactions as records (collapseReactions groups them at render)', () => {
    const out = applyLiveMessages(thread(msg('A', 'hi')), [
      msg('r1', '👍', { type: 'reaction', reactionTargetId: 'A', timestamp: SECS + 1 }),
    ]);
    expect(out.records.map((m) => m.id)).toEqual(['A', 'r1']);
  });
});

describe('mergeThreadRecords (refetch folded onto what is shown)', () => {
  it('keeps live-inserted rows a racing refetch did not have yet; fresh wins per id', () => {
    const prev = thread(msg('A', 'old'), msg('LIVE', 'just arrived', { timestamp: SECS + 30 }));
    const fresh = thread(msg('A', 'edited'), msg('B', 'two', { timestamp: SECS + 10 }));
    const out = mergeThreadRecords(prev, { ...fresh, hasMore: true });
    expect(out.records.map((m) => [m.id, m.text])).toEqual([
      ['A', 'edited'],
      ['B', 'two'],
      ['LIVE', 'just arrived'],
    ]);
    expect(out.hasMore).toBe(true);
  });

  it('is just the fresh result on first load', () => {
    const fresh = thread(msg('A', 'x'));
    expect(mergeThreadRecords(undefined, fresh)).toBe(fresh);
  });
});

describe('applyLiveToChats (bump the chat-list row)', () => {
  const raw = ({ key, ...over }: Record<string, any> = {}) => ({
    key: { remoteJid: PHONE, fromMe: false, id: 'M9', ...(key ?? {}) },
    message: { conversation: 'hello' },
    messageTimestamp: SECS + 100,
    ...over,
  });
  const chats = () => [
    { remoteJid: 'other@s.whatsapp.net', unreadCount: 0, lastMsgTimestamp: SECS },
    { remoteJid: PHONE, unreadCount: 2, lastMsgTimestamp: SECS, lastMessage: { message: { conversation: 'old' } } },
  ];

  it('sets the last message + time and counts one more unread', () => {
    const out = applyLiveToChats(chats(), raw(), { countUnread: true })!;
    expect(out[1]).toMatchObject({ unreadCount: 3, lastMsgTimestamp: (SECS + 100) * 1000 });
    expect(out[1]!.lastMessage.message.conversation).toBe('hello');
    expect(out[0]).toEqual(chats()[0]); // other rows untouched
  });

  it('does not count unread for own messages or a chat being looked at', () => {
    expect(applyLiveToChats(chats(), raw({ key: { fromMe: true } }), { countUnread: true })![1]!.unreadCount).toBe(2);
    expect(applyLiveToChats(chats(), raw(), { countUnread: false })![1]!.unreadCount).toBe(2);
  });

  it('matches a @lid message to its phone row through remoteJidAlt', () => {
    const out = applyLiveToChats(chats(), raw({ key: { remoteJid: LID, remoteJidAlt: PHONE } }), {
      countUnread: true,
    });
    expect(out?.[1]?.unreadCount).toBe(3);
  });

  it('returns null for a conversation not in the list (needs the real refetch)', () => {
    expect(applyLiveToChats(chats(), raw({ key: { remoteJid: 'new@s.whatsapp.net' } }), { countUnread: true })).toBeNull();
  });

  it('never rewinds a row with an older (replayed) record', () => {
    const list = chats();
    expect(applyLiveToChats(list, raw({ messageTimestamp: SECS - 500 }), { countUnread: true })).toBe(list);
  });

  it('accepts what parseMessage reads from the same raw record', () => {
    // the hook feeds both functions the same record — keep their notion of the jid aligned
    expect(parseMessage(raw())!.remoteJid).toBe(PHONE);
  });
});

describe('fetchThread', () => {
  const page = (records: unknown[], pages = 1) => ({ messages: { records, pages } });
  const rec = (id: string, remoteJid: string, ts: number) => ({
    key: { id, remoteJid, fromMe: false },
    message: { conversation: id },
    messageTimestamp: ts,
  });

  it('fetches every jid in parallel and merges them oldest first', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const fetchPage = (jid: string) =>
      new Promise<unknown>((resolve) => {
        started.push(jid);
        release.push(() =>
          resolve(page(jid === PHONE ? [rec('P', PHONE, SECS + 10)] : [rec('L', LID, SECS)])),
        );
      });
    const p = fetchThread([PHONE, LID], 1, fetchPage);
    await Promise.resolve();
    // both requests are in flight before either answered
    expect(started).toEqual([PHONE, LID]);
    release.forEach((r) => r());
    const out = await p;
    expect(out.records.map((m) => m.id)).toEqual(['L', 'P']);
  });

  it('one failing jid does not blank the thread; hasMore reflects any jid', async () => {
    const out = await fetchThread([PHONE, LID], 1, async (jid) => {
      if (jid === LID) throw new Error('boom');
      return page([rec('P', PHONE, SECS)], 3);
    });
    expect(out.records.map((m) => m.id)).toEqual(['P']);
    expect(out.hasMore).toBe(true);
  });
});
