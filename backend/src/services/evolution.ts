import type { EvolutionConfig } from '../config.js';

export interface EvoResponse {
  status: number;
  ok: boolean;
  text: string;
  contentType: string | null;
}

/** The surface the sender/gateway need; tests swap in a fake. */
export interface EvolutionApi {
  readonly instance: string;
  readonly configured: boolean;
  call(endpoint: string, body?: unknown, method?: string): Promise<EvoResponse>;
}

/**
 * Instance-lock guard: the reason `endpoint` may not be called while the
 * server is capped to `cfg.instance`, or null when it's fine. Evolution paths
 * are `/{controller}/{action}/{instance}[/...]`; the two instance-less
 * endpoints are handled explicitly (fetchInstances must be scoped with
 * `?instanceName=`, create is never allowed).
 */
export function lockedOut(endpoint: string, cfg: EvolutionConfig): string | null {
  if (!cfg.locked || !cfg.instance) return null;
  const q = endpoint.indexOf('?');
  const path = q < 0 ? endpoint : endpoint.slice(0, q);
  const query = q < 0 ? '' : endpoint.slice(q + 1);
  const seg = path.split('/').filter(Boolean);
  if (seg[0] === 'instance' && seg[1] === 'create') return 'creating channels is disabled (EVOLUTION_LOCK_INSTANCE)';
  if (seg[0] === 'instance' && seg[1] === 'fetchInstances') {
    const scoped = new URLSearchParams(query).get('instanceName');
    return scoped === cfg.instance ? null : `channel is locked to "${cfg.instance}"`;
  }
  if (seg.length < 3) return null;
  let target = seg[2]!;
  try {
    target = decodeURIComponent(target);
  } catch {
    return 'malformed instance in path';
  }
  return target === cfg.instance ? null : `channel is locked to "${cfg.instance}"`;
}

export class EvolutionClient implements EvolutionApi {
  constructor(
    private readonly cfg: EvolutionConfig,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  get instance(): string {
    return this.cfg.instance;
  }

  get configured(): boolean {
    return !!(this.cfg.base && this.cfg.instance && this.cfg.apikey);
  }

  async call(endpoint: string, body?: unknown, method = 'POST'): Promise<EvoResponse> {
    if (!this.cfg.base) throw new Error('Evolution API not configured (EVOLUTION_BASE)');
    const denied = lockedOut(endpoint, this.cfg);
    if (denied) return { status: 403, ok: false, text: JSON.stringify({ error: denied }), contentType: 'application/json' };
    const m = method.toUpperCase();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cfg.base}${endpoint}`, {
        method: m,
        headers: { 'Content-Type': 'application/json', apikey: this.cfg.apikey },
        // GET never carries a body; DELETE may (e.g. deleteMessageForEveryone
        // needs the message key in the body) but only when one is passed, so
        // bodyless DELETEs (leaveGroup, removeProfilePicture) are unchanged.
        body:
          m === 'GET'
            ? undefined
            : m === 'DELETE'
              ? body === undefined
                ? undefined
                : JSON.stringify(body)
              : JSON.stringify(body ?? {}),
        // a hung upstream request must not stall the scheduler or hold
        // browser connections open indefinitely
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError')
        throw new Error(`evolution request timed out after ${this.timeoutMs / 1000}s: ${endpoint}`);
      throw e;
    }
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, text, contentType: res.headers.get('content-type') };
  }
}
