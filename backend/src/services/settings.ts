import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

/** Keys persisted in the settings table. */
export type SettingKey =
  | 'evo_base'
  | 'evo_instance'
  | 'evo_apikey'
  | 'agents_enabled'
  | 'retention_days'
  | 'notify_instances';

/**
 * Operator settings stored in SQLite. Saved values override env config —
 * `applyTo` mutates the live Config object in place, which propagates
 * immediately because EvolutionClient/Scheduler hold it by reference.
 */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  all(): Partial<Record<SettingKey, string>> {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: SettingKey;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  set(values: Partial<Record<SettingKey, string>>): void {
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (value != null) upsert.run(key, value);
      }
    })();
  }

  applyTo(cfg: Config): void {
    const s = this.all();
    if (s.evo_base != null) cfg.evo.base = s.evo_base.replace(/\/+$/, '');
    // a locked server keeps the env's channel no matter what was saved earlier
    if (s.evo_instance != null && !cfg.evo.locked) cfg.evo.instance = s.evo_instance;
    if (s.evo_apikey != null) cfg.evo.apikey = s.evo_apikey;
    if (s.agents_enabled != null) cfg.agentsEnabled = s.agents_enabled === '1';
    const retention = Number(s.retention_days);
    if (s.retention_days != null && Number.isInteger(retention) && retention >= 0)
      cfg.retentionDays = retention;
    if (s.notify_instances != null)
      cfg.notifyInstances = s.notify_instances
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);
  }
}
