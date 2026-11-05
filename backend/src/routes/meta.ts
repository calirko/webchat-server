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

export function registerMeta(app: FastifyInstance): void {
  const version = readVersion();

  // Health / mode probe — the SPA uses this to detect "server mode".
  app.get('/api/health', async () => ({ ok: true, mode: 'server', version }));
}
