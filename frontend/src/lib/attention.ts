/**
 * What the agent is looking at right now — decides whether an incoming
 * message is already "seen" (silent), needs only a chime (another chat while
 * the app is in front), or a system notification too (app in the background
 * or another window focused).
 */

/** Every jid the open thread spans (@lid + phone aliases); empty = no thread open. */
let openJids = new Set<string>();

export function setOpenChat(jids: readonly string[] | null): void {
  openJids = new Set(jids ?? []);
}

/** Whether `jid` belongs to the conversation currently open on screen. */
export function isOpenChat(jid: string | undefined | null): boolean {
  return !!jid && openJids.has(jid);
}

/** The app tab is visible AND its window has focus. */
export function isLooking(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible' && document.hasFocus();
}
