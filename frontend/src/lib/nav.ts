/**
 * Lightweight cross-tree navigation. Deep links (e.g. a modal "manage" link, or a clicked
 * notification) ask App to switch tabs / open a chat via a window event instead
 * of threading a callback everywhere.
 */
export const NAV_EVENT = 'wa:navigate';

export interface NavTarget {
  /** tab to switch to (when no chat is given) */
  tab?: string;
  /** open the chat with this jid (DM or group) */
  chat?: string;
  /** within that chat, scroll to + flash this message id */
  msg?: string;
}

export function navigate(target: NavTarget): void {
  window.dispatchEvent(new CustomEvent<NavTarget>(NAV_EVENT, { detail: target }));
}

export function navigateTab(tab: string): void {
  navigate({ tab });
}

/**
 * Parse a notification deep-link (`/?chat=<jid>&msg=<id>`) into
 * a NavTarget, or null when the URL carries no recognised target. Shared by the
 * cold-start (openWindow) and warm-start (SW postMessage) paths.
 */
export function targetFromUrl(url: string): NavTarget | null {
  try {
    const u = new URL(url, window.location.origin);
    const chat = u.searchParams.get('chat');
    if (chat) return { tab: 'chat', chat, msg: u.searchParams.get('msg') ?? undefined };
    return null;
  } catch {
    return null;
  }
}
