import { unwrapEvent } from './envelope.js';
import type { EventRelay } from './events.js';
import type { Db } from '../db/index.js';

/**
 * Server-side record of WHEN the recipient read one of our sent messages.
 * Fed by attachReadTracker below (MESSAGES_UPDATE → READ/PLAYED) and read by
 * the findMessages proxy to attach a `readAt` onto each record. This is the only
 * place the read time survives: this Evolution build's stored MessageUpdate
 * history carries a status string but no timestamp, so once the live ack is gone
 * the time is unrecoverable from any later fetch — exactly the gap message_cache
 * fills for deleted content.
 *
 * First ack wins: the earliest READ is when they actually saw it; later acks
 * (a re-open of the chat) must not bump it.
 */
export class ReadReceiptStore {
  private readonly q;

  constructor(db: Db) {
    this.q = {
      // INSERT OR IGNORE → keep the first (earliest) read time per message
      mark: db.prepare(
        `INSERT OR IGNORE INTO message_reads (message_id, read_at) VALUES (?, ?)`,
      ),
      byId: db.prepare(`SELECT read_at FROM message_reads WHERE message_id = ?`),
    };
  }

  /** Stamp the read time for a message. No-op without an id; first ack wins. */
  markRead(messageId: string, at: string = new Date().toISOString()): void {
    if (!messageId) return;
    this.q.mark.run(messageId, at);
  }

  /** ISO time the recipient read this message, or null if we never saw a READ ack. */
  readAtFor(messageId: string): string | null {
    if (!messageId) return null;
    const row = this.q.byId.get(messageId) as { read_at?: string } | undefined;
    return row?.read_at ?? null;
  }
}

// Evolution emits either string statuses or raw WhatsApp ack numbers.
const READ_STATUSES = new Set(['READ', 'PLAYED', '4', '5']);

/**
 * Stamp the read time of any sent message the moment its READ/PLAYED ack
 * arrives on MESSAGES_UPDATE — the only chance to capture it (the stored
 * MessageUpdate history has no timestamp).
 */
export function attachReadTracker(relay: EventRelay, onRead: (messageId: string) => void): void {
  relay.subscribe((e) => {
    if (e.event !== 'MESSAGES_UPDATE' && e.event !== 'messages.update') return;
    const records = unwrapEvent(e.data).records as Array<{
      keyId?: string;
      messageId?: string;
      key?: { id?: string };
      status?: unknown;
      update?: { status?: unknown };
    }>;
    for (const r of records) {
      const id = r.keyId ?? r.key?.id ?? r.messageId;
      if (typeof id !== 'string' || !id) continue;
      const status = String(r.status ?? r.update?.status ?? '').toUpperCase();
      if (READ_STATUSES.has(status)) onRead(id);
    }
  });
}
