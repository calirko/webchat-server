import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * One shared EventSource for the whole app. Every hook used to open its own
 * /api/events stream (ChatPage + JobsPage = two connections); with the v2.8
 * workbench events needing app-wide delivery (reminders, approvals,
 * presence), subscriptions now fan out from a single ref-counted connection.
 */

export type BusHandler = (data: unknown) => void;

const handlers = new Map<string, Set<BusHandler>>();
let es: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attached = new Set<string>();
let total = 0;

/**
 * Live-stream health for the UI: 'open' while events flow, 'connecting' during
 * a (re)connect. An outage used to be invisible — the app just felt slow,
 * because the only fallbacks are the 10s thread poll and 60s list poll.
 */
export type BusState = 'connecting' | 'open';
let state: BusState = 'connecting';
let everOpened = false;
let retryDelay = 1000;
const stateListeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

function setState(next: BusState): void {
  if (next === state) return;
  state = next;
  for (const fn of stateListeners) fn();
}

export function useBusState(): BusState {
  return useSyncExternalStore(
    (fn) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    () => state,
  );
}

/**
 * Called each time the stream comes back after having been open — events in
 * the gap are lost for good, so listeners refetch whatever they keep live.
 */
export function onBusReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

function dispatchTo(event: string, e: MessageEvent): void {
  let data: unknown;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  for (const fn of handlers.get(event) ?? []) {
    try {
      fn(data);
    } catch {
      /* one bad subscriber must not break the rest */
    }
  }
}

function attach(event: string): void {
  if (!es || attached.has(event)) return;
  attached.add(event);
  es.addEventListener(event, (e) => dispatchTo(event, e as MessageEvent));
}

function scheduleRetry(): void {
  if (total <= 0 || retryTimer) return;
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 15_000); // 1s, 2s, 4s … capped at 15s
}

function connect(): void {
  retryTimer = null;
  setState('connecting');
  es = new EventSource('/api/events');
  attached = new Set();
  for (const event of handlers.keys()) attach(event);
  es.onopen = () => {
    retryDelay = 1000;
    setState('open');
    if (everOpened) for (const fn of reconnectListeners) fn();
    everOpened = true;
  };
  // EventSource auto-retries only network drops (on its own `retry:` clock);
  // an HTTP error response (e.g. a proxy 502 while the backend restarts)
  // closes it permanently — recreate the stream ourselves with backoff or
  // live updates die until a full reload.
  es.onerror = () => {
    setState('connecting');
    if (es?.readyState === EventSource.CLOSED) {
      es.close();
      es = null;
      scheduleRetry();
    }
  };
}

export function subscribeBus(event: string, fn: BusHandler): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(fn);
  total++;
  if (!es && !retryTimer) connect();
  else attach(event);
  return () => {
    set.delete(fn);
    if (!set.size) handlers.delete(event);
    total--;
    if (total <= 0) {
      total = 0;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      es?.close();
      es = null;
      setState('connecting');
    }
  };
}

/** Subscribe for the component's lifetime; the handler may change freely. */
export function useBusEvent(event: string | readonly string[], fn: BusHandler): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = Array.isArray(event) ? event.join('|') : (event as string);
  useEffect(() => {
    const events = key.split('|');
    const subs = events.map((ev) => subscribeBus(ev, (d) => ref.current(d)));
    return () => subs.forEach((u) => u());
  }, [key]);
}
