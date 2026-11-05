import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const { app, relay, housekeeping } = await buildApp({
    cfg,
    db,
    logger: true,
  });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  housekeeping.start();
  relay.start();
  app.log.info(
    `webchat-server up — static=${cfg.staticDir} db=${cfg.dbPath} ` +
      `evolution=${cfg.evo.base ? `${cfg.evo.base} (${cfg.evo.instance})` : '(not configured)'} ` +
      `auth=${cfg.apiToken ? 'token' : 'off'}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close(); // also stops the relay + housekeeping via onClose
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
