/** Wall-clock / timestamp helpers shared by the notification paths. */

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < 24 * 60 ? minutes : null;
}

/** Whether `now` falls inside the quiet window; supports overnight windows. */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s == null || e == null || s === e) return false;
  const n = now.getHours() * 60 + now.getMinutes();
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/**
 * Evolution's `messageTimestamp` (seconds | ms | numeric string | protobuf
 * Long) → epoch ms, or null when absent/invalid.
 */
export function messageTimeMs(raw: unknown): number | null {
  let n: number | null = null;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim()) n = Number(raw);
  else if (raw && typeof raw === 'object' && typeof (raw as { low?: unknown }).low === 'number')
    n = (raw as { low: number }).low;
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n; // seconds vs ms
}
