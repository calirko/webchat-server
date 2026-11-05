import type { MessageItem } from '../types.js';
import type { EvolutionApi } from './evolution.js';
import { buildEvoRequest } from './messages.js';

export interface SendOutcome {
  status: 'sent';
  messageId?: string;
}

/** Best-effort extraction of the message id Evolution assigned to a send. */
function extractMessageId(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { key?: { id?: unknown }; messageId?: unknown };
    const id = data?.key?.id ?? data?.messageId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Sends one item to one recipient through Evolution. Throws on failure. */
export class Sender {
  constructor(private readonly evo: EvolutionApi) {}

  /** `instance` defaults to the Settings default line. */
  async sendOne(recipient: string, item: MessageItem, instance?: string): Promise<SendOutcome> {
    const { endpoint, body } = buildEvoRequest(item, recipient, instance || this.evo.instance);
    const r = await this.evo.call(endpoint, body, 'POST');
    if (!r.ok) throw new Error(`evolution ${r.status}: ${r.text.slice(0, 200)}`);
    return { status: 'sent', messageId: extractMessageId(r.text) };
  }
}
