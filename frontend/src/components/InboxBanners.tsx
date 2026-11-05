import { useEffect, useState } from 'react';
import { useBusState } from '../lib/eventBus';
import { enableNotifications, shouldOfferNotifications } from '../lib/notify';
import { useToast } from './Toast';

const PROMPT_DISMISSED_KEY = 'wa_notify_prompt_dismissed';
/** Don't flash the warning for an ordinary sub-second reconnect. */
const DEGRADED_GRACE_MS = 5_000;

function promptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Says so when live updates aren't flowing — either this browser's stream to
 * the server is down, or the server's own websocket to Evolution is. Either
 * way messages still arrive, but only on the polling fallback, and an outage
 * used to just feel like "the app is slow".
 */
function LiveStatusBanner({ upstream }: { upstream?: 'off' | 'connected' | 'disconnected' }) {
  const bus = useBusState();
  const reason = bus !== 'open' ? 'stream' : upstream === 'disconnected' ? 'upstream' : null;
  const [shown, setShown] = useState<typeof reason>(null);
  useEffect(() => {
    if (!reason) {
      setShown(null);
      return;
    }
    const t = setTimeout(() => setShown(reason), DEGRADED_GRACE_MS);
    return () => clearTimeout(t);
  }, [reason]);
  if (!shown) return null;
  return (
    <div role="status" className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-800">
      {shown === 'stream'
        ? 'Reconnecting to live updates — new messages may take up to 10 seconds to appear.'
        : 'The server has lost WhatsApp’s live feed — new messages may take up to 10 seconds to appear.'}
    </div>
  );
}

/**
 * One-time nudge to turn on notifications on this device — they were opt-in
 * and buried in Preferences, so most people never had them.
 */
function NotificationPrompt() {
  const toast = useToast();
  const [visible, setVisible] = useState(() => shouldOfferNotifications() && !promptDismissed());
  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(PROMPT_DISMISSED_KEY, '1');
    } catch {
      /* storage unavailable — the prompt just comes back next load */
    }
    setVisible(false);
  };

  async function turnOn() {
    const ok = await enableNotifications();
    setVisible(false);
    if (ok) toast('Notifications on — you’ll hear and see new messages even with the app in the background');
    else toast('Notifications were blocked — allow them in the browser’s site settings', 'err');
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-green-200 bg-green-50 px-4 py-1.5 text-xs text-wa-dark">
      <span>Get notified about new messages, even when this tab is in the background.</span>
      <span className="flex gap-2">
        <button
          onClick={() => void turnOn()}
          className="rounded-md bg-wa px-2.5 py-1 font-semibold text-white hover:bg-wa-dark"
        >
          Turn on
        </button>
        <button onClick={dismiss} className="rounded-md px-2 py-1 font-medium text-gray-500 hover:bg-green-100">
          Not now
        </button>
      </span>
    </div>
  );
}

export function InboxBanners({ upstream }: { upstream?: 'off' | 'connected' | 'disconnected' }) {
  return (
    <>
      <LiveStatusBanner upstream={upstream} />
      <NotificationPrompt />
    </>
  );
}
