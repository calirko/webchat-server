/** One outgoing message: `type` picks the Evolution endpoint (see messages.ts#buildEvoRequest). */
export interface MessageItem {
  type: string;
  data: Record<string, unknown>;
}
