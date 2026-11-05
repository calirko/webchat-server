import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function registerMeta(
  app: FastifyInstance,
  relay?: { upstreamStatus: 'off' | 'connected' | 'disconnected' },
): void {
  const version = readVersion();

  // Health / mode probe. `events` is whether Evolution's websocket is actually
  // delivering — when it isn't, the UI says so instead of just feeling slow.
  app.get('/api/health', async () => ({
    ok: true,
    mode: 'server',
    version,
    events: relay?.upstreamStatus ?? 'off',
  }));
}
