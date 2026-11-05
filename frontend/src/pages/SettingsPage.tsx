import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { Switch } from '../components/Switch';
import { AGENT_COLOR_KEYS, agentBadgeClass, agentLabel, useAgents, useIsAdmin } from '../lib/agents';
import { api } from '../lib/api';
import { useInstances } from '../lib/instance';
import type { Agent, AgentRole, CleanupResult, MaintenanceReport, PermissionKey, Perms } from '../types';
import { notificationsEnabled } from '../lib/notify';

/**
 * Rough disk footprint of a stored WhatsApp message on the Evolution Postgres,
 * measured on the studio server (Message table ≈ 402 MB for ≈ 238k messages →
 * ~1.7 KB each, payload + indexes). Only ever shown as an "≈" estimate — the
 * webchat backend can't read Evolution's table sizes directly.
 */
const AVG_MSG_BYTES = 1740;

const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();

/** The permission switches an admin actually tunes per agent. The page-access
 * pair (settings.manage / agents.manage) stays role-driven — overriding those
 * per agent invites lockouts for no current need. */
const GRANTABLE: Array<{ key: PermissionKey; label: string; hint: string }> = [
  { key: 'settings.manage', label: 'Manage settings', hint: 'Evolution connection, retention, maintenance, channels' },
  { key: 'agents.manage', label: 'Manage agents', hint: 'Edit roles, permissions and channel grants' },
];

/** One agent of the roster: display name, badge color, role, active flag. */
function AgentRow({ agent, instanceNames }: { agent: Agent; instanceNames: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(agent.name);
  const [color, setColor] = useState(agent.color);
  const [showPerms, setShowPerms] = useState(false);
  const save = useMutation({
    mutationFn: (patch: {
      name?: string;
      color?: string;
      active?: boolean;
      role?: AgentRole;
      perms?: Partial<Perms>;
      instances?: string[] | null;
    }) => api.agents.update(agent.email, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      // self-demotion: tabs react as soon as /api/me refreshes
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast(String((e as Error).message), 'err'),
  });
  const dirty = name.trim() !== agent.name || color !== agent.color;

  function togglePerm(key: PermissionKey) {
    // send the stored overrides with this key flipped to the new desired
    // value — the server prunes whatever matches the role default
    save.mutate({ perms: { ...agent.perms, [key]: !agent.effectivePerms[key] } });
  }

  function toggleInstance(name: string) {
    const current = agent.instances ?? [];
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    // [] clears back to "default line only"
    save.mutate({ instances: next.length ? next : null });
  }
  return (
    <div className={`py-2 ${agent.active ? '' : 'opacity-50'}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full px-2 py-0.5 text-xs font-medium ${agentBadgeClass(color)}`}
        title={`last seen ${new Date(agent.lastSeenAt).toLocaleString()}`}
      >
        {agentLabel({ name: name.trim(), email: agent.email })}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-500" dir="ltr">
        {agent.email}
      </span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Display name"
        className="w-32 rounded-md border border-gray-300 px-2 py-1 text-xs"
      />
      <select
        value={color}
        onChange={(e) => setColor(e.target.value)}
        aria-label="Badge color"
        className="rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-800"
      >
        <option value="">color…</option>
        {AGENT_COLOR_KEYS.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        value={agent.role}
        onChange={(e) => save.mutate({ role: e.target.value as AgentRole })}
        disabled={save.isPending}
        aria-label={`${agent.email} role`}
        title="admin: full access · agent: no Settings"
        className="rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-800"
      >
        <option value="admin">admin</option>
        <option value="agent">agent</option>
      </select>
      {dirty && (
        <button
          onClick={() => save.mutate({ name: name.trim(), color })}
          disabled={save.isPending}
          className="rounded px-2 py-1 text-xs font-medium text-wa-dark hover:bg-green-50 disabled:opacity-50"
        >
          Save
        </button>
      )}
      <button
        onClick={() => setShowPerms(!showPerms)}
        title="Permissions"
        className={`rounded px-2 py-1 text-xs ${showPerms ? 'bg-gray-100 text-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
      >
        perms {showPerms ? '▴' : '▾'}
      </button>
      <Switch
        on={agent.active}
        onToggle={() => save.mutate({ active: !agent.active })}
        label={`${agent.email} active`}
      />
    </div>
    {showPerms && (
      <div className="mt-2 space-y-2 rounded-md bg-gray-50 px-3 py-2">
        <div className="grid gap-1.5 sm:grid-cols-2">
          {GRANTABLE.map(({ key, label, hint }) => (
            <label key={key} title={hint} className="flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={agent.effectivePerms[key]}
                disabled={save.isPending}
                onChange={() => togglePerm(key)}
                className="h-3.5 w-3.5 accent-wa"
              />
              {label}
              {agent.perms[key] !== undefined && (
                <span className="text-[10px] text-gray-400" title="differs from the role default">
                  (override)
                </span>
              )}
            </label>
          ))}
        </div>
        {instanceNames.length > 1 && (
          <div className="border-t border-gray-200 pt-2">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              WhatsApp channels{' '}
              <span className="font-normal normal-case">
                {agent.role === 'admin'
                  ? '— admins always see every channel'
                  : agent.instances?.length
                    ? ''
                    : '— none checked = the default channel only'}
              </span>
            </p>
            <div className="flex flex-wrap gap-3">
              {instanceNames.map((name) => (
                <label key={name} className="flex items-center gap-1.5 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    checked={agent.role === 'admin' || (agent.instances ?? []).includes(name)}
                    disabled={save.isPending || agent.role === 'admin'}
                    onChange={() => toggleInstance(name)}
                    className="h-3.5 w-3.5 accent-wa"
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    )}
    </div>
  );
}

/** The auto-provisioned agent roster (shown while the toggle is on). */
function AgentsTable() {
  const agents = useAgents();
  const instances = useInstances();
  const instanceNames = (instances.data?.instances ?? []).map((i) => i.name);
  if (agents.isLoading)
    return <p className="border-t border-gray-100 pt-3 text-xs text-gray-400">Loading agents…</p>;
  if (!agents.data?.length)
    return (
      <p className="border-t border-gray-100 pt-3 text-xs text-gray-400">
        No agents yet — each one appears here automatically after their first visit.
      </p>
    );
  return (
    <div className="divide-y divide-gray-100 border-t border-gray-100">
      {agents.data.map((a) => (
        <AgentRow key={a.email} agent={a} instanceNames={instanceNames} />
      ))}
    </div>
  );
}

/** The sidebar's section list — ids match the section wrappers below. */
const NAV_ITEMS: Array<{ id: string; label: string }> = [
  { id: 'connection', label: 'Connection' },
  { id: 'agents', label: 'Agents' },
  { id: 'retention', label: 'Data retention' },
  { id: 'maintenance', label: 'Maintenance' },
  { id: 'notifications', label: 'Notifications' },
];

function NavIcon({ id }: { id: string }) {
  const p = { className: 'h-[18px] w-[18px] shrink-0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24' };
  switch (id) {
    case 'connection':
      return <svg {...p}><path d="M9 3v4M15 3v4M7 7h10l-1 5a4 4 0 0 1-4 3.2A4 4 0 0 1 8 12L7 7Z" /><path d="M12 15.2V19M9 21h6" /></svg>;
    case 'agents':
      return <svg {...p}><circle cx="9" cy="9" r="2.8" /><path d="M3.5 18c.6-3 2.7-4.6 5.5-4.6s4.9 1.6 5.5 4.6" /><circle cx="17" cy="8" r="2.2" /><path d="M15.3 13.6c2.2.3 3.8 1.8 4.2 4.4" /></svg>;
    case 'retention':
      return <svg {...p}><ellipse cx="12" cy="6" rx="7" ry="2.6" /><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" /><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6" /></svg>;
    case 'maintenance':
      return <svg {...p}><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.3 2.3-2-2 2.3-2.3Z" /></svg>;
    case 'notifications':
      return <svg {...p}><path d="M6 10a6 6 0 1 1 12 0c0 4 1.3 5.5 1.3 5.5H4.7S6 14 6 10Z" /><path d="M10 18.5a2 2 0 0 0 4 0" /></svg>;
    default:
      return null;
  }
}

/** Section switcher: a sticky vertical list on wide screens, a horizontal
 * chip strip on narrow ones. Picking a section swaps the content pane below
 * it in place — nothing to scroll through to get back to the nav. */
function SettingsNav({ active, onSelect }: { active: string; onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const items = NAV_ITEMS.filter((i) => !q || i.label.toLowerCase().includes(q));

  return (
    <>
      <div className="sticky top-4 hidden w-52 flex-none rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm lg:block">
        <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Jump to</p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter sections…"
          aria-label="Filter settings sections"
          className="mb-2 w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-xs"
        />
        <div className="flex flex-col">
          {items.map((i) => (
            <button
              key={i.id}
              onClick={() => onSelect(i.id)}
              className={`flex items-center gap-2.5 rounded-md border-l-[3px] px-2 py-1.5 text-left text-[13px] ${
                active === i.id
                  ? 'border-wa bg-green-50 font-medium text-wa-dark'
                  : 'border-transparent text-gray-600 hover:bg-gray-50'
              }`}
            >
              <NavIcon id={i.id} />
              {i.label}
            </button>
          ))}
          {items.length === 0 && <p className="px-2 py-1.5 text-xs text-gray-400">No matching section</p>}
        </div>
      </div>

      <div className="flex w-full gap-2 overflow-x-auto rounded-xl border border-gray-200 bg-white p-2 shadow-sm lg:hidden">
        {NAV_ITEMS.map((i) => (
          <button
            key={i.id}
            onClick={() => onSelect(i.id)}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs ${
              active === i.id
                ? 'border-wa bg-green-50 font-medium text-wa-dark'
                : 'border-gray-200 text-gray-600'
            }`}
          >
            <NavIcon id={i.id} />
            {i.label}
          </button>
        ))}
      </div>
    </>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

/** The instances Evolution actually hosts, as click-to-fill chips. */
function InstanceChips({ current, onPick }: { current: string; onPick: (name: string) => void }) {
  const q = useInstances();
  const list = q.data?.instances ?? [];
  if (list.length < 2) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {list.map((i) => (
        <button
          key={i.name}
          type="button"
          onClick={() => onPick(i.name)}
          title={i.connectionStatus === 'open' ? 'connected' : 'disconnected'}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
            current.trim() === i.name
              ? 'border-wa bg-green-50 text-wa-dark'
              : 'border-gray-200 bg-white text-gray-600 hover:border-wa'
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              i.connectionStatus === 'open' ? 'bg-wa' : 'bg-red-500'
            }`}
          />
          {i.name}
        </button>
      ))}
    </div>
  );
}

/** Disk / DB / Evolution storage telemetry + retention status (admins). */
function ServerHealth() {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const isAdmin = useIsAdmin();
  const q = useQuery({
    queryKey: ['maintenance'],
    queryFn: api.maintenance.get,
    staleTime: 60_000,
    retry: 1,
  });
  const del = useMutation({
    mutationFn: (name: string) => api.instances.remove(name),
    onSuccess: (_r, name) => {
      toast(`Deleted “${name}” and its stored history`, 'ok');
      qc.invalidateQueries({ queryKey: ['maintenance'] });
      qc.invalidateQueries({ queryKey: ['instances'] });
    },
    onError: (e) => toast((e as Error).message || 'Failed to delete channel', 'err'),
  });
  async function deleteChannel(name: string, isDefault: boolean) {
    if (isDefault) {
      toast('Change the default channel under Connection before deleting it', 'err');
      return;
    }
    const ok = await confirm({
      title: `Delete “${name}”?`,
      body: 'This permanently deletes the channel and every WhatsApp message, chat and contact it stored on the Evolution server. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) del.mutate(name);
  }
  if (q.isLoading) return <p className="py-6 text-center text-sm text-gray-400">Loading…</p>;
  if (q.isError)
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">Server health</h3>
        <p role="alert" className="text-sm text-red-500">{(q.error as Error).message}</p>
      </div>
    );
  const d = q.data as MaintenanceReport;
  const usedPct = d.disk ? Math.round(((d.disk.totalBytes - d.disk.freeBytes) / d.disk.totalBytes) * 100) : null;
  const diskLow = d.disk != null && (usedPct! >= 85 || d.disk.freeBytes < 10e9);
  const deadInstances = (d.evolution ?? []).filter((i) => i.connectionStatus !== 'open');
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-700">Server health & storage</h3>

      {diskLow && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-600">
          ⚠ Disk is filling up — {fmtBytes(d.disk!.freeBytes)} free. Consider running a cleanup below.
        </p>
      )}

      {d.disk && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-500">
            <span>Server disk</span>
            <span>
              {fmtBytes(d.disk.totalBytes - d.disk.freeBytes)} used of {fmtBytes(d.disk.totalBytes)} ({usedPct}%)
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full ${diskLow ? 'bg-red-500' : usedPct! >= 70 ? 'bg-amber-400' : 'bg-wa'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs text-gray-400">App database</p>
          <p className="font-medium text-gray-700">
            {fmtBytes(d.db.sizeBytes)}
            {d.db.walBytes > 0 && <span className="text-xs text-gray-400"> +{fmtBytes(d.db.walBytes)} WAL</span>}
          </p>
          <p className="text-xs text-gray-500">
            {fmtNum(d.tables.jobs ?? 0)} jobs · {fmtNum(d.tables.job_sends ?? 0)} ledger rows ·{' '}
            {fmtNum(d.tables.message_agents ?? 0)} attributions
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-3 py-2">
          <p className="text-xs text-gray-400">History retention</p>
          <p className="font-medium text-gray-700">
            {d.retentionDays > 0 ? `auto-purge after ${d.retentionDays} days` : 'off — history kept forever'}
          </p>
          <p className="text-xs text-gray-500">configure under Data retention</p>
        </div>
      </div>

      <div>
        <p className="mb-1 text-xs text-gray-400">WhatsApp messages stored on the Evolution server (per channel)</p>
        {d.evolutionError ? (
          <p className="text-sm text-red-500">Evolution unreachable — {d.evolutionError}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(d.evolution ?? []).map((i) => {
              const isDefault = i.name === d.defaultInstance;
              return (
                <li key={i.name} className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-gray-600">
                    <span
                      className={`inline-block h-2 w-2 shrink-0 rounded-full ${i.connectionStatus === 'open' ? 'bg-wa' : 'bg-red-500'}`}
                    />
                    <span className="truncate">{i.name}</span>
                    {isDefault && <span className="shrink-0 text-[10px] text-gray-400">(default)</span>}
                    {i.connectionStatus !== 'open' && (
                      <span className="shrink-0 text-xs text-red-500">
                        disconnected{i.disconnectedAt ? ` since ${new Date(i.disconnectedAt).toLocaleDateString()}` : ''}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-right text-gray-700">
                      {i.counts ? (
                        <>
                          {fmtNum(i.counts.messages)} msgs · {fmtNum(i.counts.chats)} chats
                          <span
                            className="block text-[10px] text-gray-400"
                            title={`Estimated at ~${AVG_MSG_BYTES} bytes per stored message`}
                          >
                            ≈ {fmtBytes(i.counts.messages * AVG_MSG_BYTES)} on disk
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </span>
                    {isAdmin && (
                      <button
                        title={isDefault ? 'Change the default channel before deleting it' : `Delete “${i.name}”`}
                        onClick={() => deleteChannel(i.name, isDefault)}
                        disabled={del.isPending && del.variables === i.name}
                        className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-red-500 hover:bg-red-50 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {!d.evolutionError && (d.evolution ?? []).some((i) => i.counts) && (
          <p className="mt-1 text-[10px] text-gray-400">
            Chat-message sizes are estimated (~{(AVG_MSG_BYTES / 1024).toFixed(1)} KB each) — the
            stored messages live on the Evolution server, separate from this app's job history.
          </p>
        )}
        {deadInstances.length > 0 && (
          <p className="mt-1 text-xs text-amber-600">
            Disconnected channels keep their stored history on the server — reconnect them from the
            Evolution manager or consider archiving.
          </p>
        )}
      </div>
    </div>
  );
}

/** Manual cleanup: dry-run preview first, the destructive run needs a click more. */
function MaintenanceCard() {
  const toast = useToast();
  const [days, setDays] = useState('90');
  const [preview, setPreview] = useState<CleanupResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1) return toast('Days must be a whole number ≥ 1', 'err');
    setBusy(true);
    try {
      const r = await api.maintenance.cleanup(n, dryRun ? { dryRun: true } : { vacuum: true });
      if (dryRun) setPreview(r);
      else {
        setPreview(null);
        toast(
          `Cleaned up: ${r.jobs} jobs, ${r.sends} ledger rows, ${r.outboundSends} outbound log rows, ${r.messageAgents} attributions, ${r.messageCache} cached bodies, ${r.messageEdits} edit versions` +
            (r.vacuumed ? ` — DB ${fmtBytes(r.bytesBefore)} → ${fmtBytes(r.bytesAfter)}` : '') +
            (r.note ? ` (${r.note})` : ''),
        );
      }
    } catch (e) {
      toast(String((e as Error).message), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-700">Maintenance</h3>
      <p className="text-xs text-gray-500">
        Free up space by deleting finished jobs (and their send ledgers), message attributions,
        cached message bodies and fired reminders older than a cutoff. Scheduled, running and held
        jobs are never touched; Insights aggregates are kept.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-gray-700">Delete history older than</label>
        <input
          type="number"
          min={1}
          step={1}
          value={days}
          onChange={(e) => {
            setDays(e.target.value);
            setPreview(null);
          }}
          aria-label="Cleanup cutoff (days)"
          className="w-20 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
        <span className="text-sm text-gray-700">days</span>
        <button
          onClick={() => void run(true)}
          disabled={busy}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 disabled:opacity-50"
        >
          Preview
        </button>
        {preview && (
          <button
            onClick={() => void run(false)}
            disabled={busy}
            className="rounded-lg bg-red-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
          >
            Delete{' '}
            {preview.jobs +
            preview.outboundSends +
            preview.messageAgents +
            preview.messageCache +
            preview.messageEdits +
            preview.reminders
              ? 'now'
              : 'anyway'}
          </button>
        )}
      </div>
      {preview && (
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600" role="status">
          Would delete <b>{preview.jobs}</b> jobs ({preview.sends} ledger rows),{' '}
          <b>{preview.outboundSends}</b> outbound log rows, <b>{preview.messageAgents}</b> message
          attributions, <b>{preview.messageCache}</b> cached message bodies,{' '}
          <b>{preview.messageEdits}</b> edit versions and <b>{preview.reminders}</b> old reminders.
          Nothing has been deleted yet.
        </p>
      )}
    </div>
  );
}

/**
 * Server settings: Evolution connection, agents, retention, maintenance and
 * which channels notify. Stored on the server (SQLite) — the API key never
 * reaches the browser; an empty key field means "keep the saved one".
 */
export default function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings.get });

  const [base, setBase] = useState('');
  const [instance, setInstance] = useState('');
  const [apikey, setApikey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [agentsOn, setAgentsOn] = useState(false);
  const [retention, setRetention] = useState('0');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Evolution lines that fire push notifications ([] = default line only).
  const [notifyInstances, setNotifyInstances] = useState<string[]>([]);
  const instancesList = useInstances();
  const [activeSection, setActiveSection] = useState('connection');

  // live connection status banner — tests the saved server-side settings
  const conn = useQuery({
    queryKey: ['settings-conn'],
    queryFn: () => api.settings.test({}),
    staleTime: 60_000,
    retry: 0,
  });

  useEffect(() => {
    if (!settings.data) return;
    setBase(settings.data.base);
    setInstance(settings.data.instance);
    setAgentsOn(settings.data.agentsEnabled);
    setRetention(String(settings.data.retentionDays));
    setNotifyInstances(settings.data.notifyInstances ?? []);
  }, [settings.data]);

  async function save() {
    setFeedback(null);
    if (!base.trim() || !instance.trim())
      return setFeedback({ kind: 'err', text: 'Server URL and instance name are required' });
    const retentionDays = Number(retention);
    if (!Number.isInteger(retentionDays) || retentionDays < 0)
      return setFeedback({ kind: 'err', text: 'Retention must be a whole number of days (0 = keep forever)' });
    setBusy(true);
    try {
      await api.settings.save({
        base: base.trim(),
        instance: instance.trim(),
        ...(apikey.trim() ? { apikey: apikey.trim() } : {}),
        agentsEnabled: agentsOn,
        retentionDays,
        notifyInstances,
      });
      setApikey('');
      toast('Settings saved');
      qc.invalidateQueries({ queryKey: ['settings'] });
      // the header chip and chat badges key off /api/me — refresh the gate
      qc.invalidateQueries({ queryKey: ['me'] });
      // the status banner tests the SAVED settings — refresh it too, or it
      // keeps reporting the previous server until remount
      qc.invalidateQueries({ queryKey: ['settings-conn'] });
      setBusy(false);
      // prove the saved connection actually works right away
      await testConnection();
      return;
    } catch (e) {
      setFeedback({ kind: 'err', text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setFeedback(null);
    setBusy(true);
    try {
      const r = await api.settings.test({
        base: base.trim(),
        instance: instance.trim(),
        ...(apikey.trim() ? { apikey: apikey.trim() } : {}),
      });
      if (!r.ok) setFeedback({ kind: 'err', text: `Connection failed: ${r.error}` });
      else
        setFeedback({
          kind: r.instanceFound ? 'ok' : 'err',
          text: r.instanceFound
            ? `Connected — ${r.instances} instance(s), “${instance.trim()}” found ✓`
            : `Connected (${r.instances} instance(s)) but instance “${instance.trim()}” was not found`,
        });
    } catch (e) {
      setFeedback({ kind: 'err', text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  const keyPlaceholder = settings.data?.apikeySet
    ? `saved ${settings.data.apikeyHint} — leave blank to keep`
    : 'Evolution API key';

  return (
    <div className="mx-auto flex max-w-5xl flex-col items-start gap-6 overflow-y-auto p-4 lg:flex-row">
      <SettingsNav active={activeSection} onSelect={setActiveSection} />
      <div className="max-w-2xl flex-1 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">Settings</h2>
        <p className="text-sm text-gray-500">
          Evolution connection, agents and housekeeping. Stored on the server — the API key never leaves it.
        </p>
      </div>

      <div
        role="status"
        className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-sm ${
          conn.isLoading
            ? 'border-gray-200 bg-white text-gray-400'
            : conn.data?.ok && conn.data.instanceFound
              ? 'border-green-200 bg-green-50 text-wa-dark'
              : 'border-red-200 bg-red-50 text-red-600'
        }`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
            conn.isLoading
              ? 'animate-pulse bg-gray-300'
              : conn.data?.ok && conn.data.instanceFound
                ? 'bg-wa'
                : 'bg-red-500'
          }`}
        />
        {conn.isLoading
          ? 'Checking connection…'
          : conn.data?.ok && conn.data.instanceFound
            ? `Connected — instance “${settings.data?.instance ?? ''}” is live`
            : conn.data?.ok
              ? `Server reachable, but instance “${settings.data?.instance ?? ''}” was not found`
              : `Not connected${conn.data?.error ? ` — ${conn.data.error}` : ''}`}
      </div>

      {activeSection === 'connection' && (
      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700">Evolution API connection</h3>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Server URL</label>
          <input
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="https://your-evolution-server.example"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Default channel
          </label>
          <input
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
            placeholder="my-instance"
            readOnly={settings.data?.instanceLocked}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm read-only:bg-gray-50 read-only:text-gray-500"
          />
          {settings.data?.instanceLocked ? (
            <p className="mt-1 text-xs text-gray-500">
              Locked by <code>EVOLUTION_LOCK_INSTANCE</code> — the server never touches other channels.
            </p>
          ) : (
            <>
              <InstanceChips current={instance} onPick={setInstance} />
              <p className="mt-1 text-xs text-gray-500">
                The channel everyone works on unless an agent is granted others (roster → perms) or
                switches channels in the header.
              </p>
            </>
          )}
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">API key</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apikey}
              onChange={(e) => setApikey(e.target.value)}
              placeholder={keyPlaceholder}
              autoComplete="new-password"
              className="w-full rounded-md border border-gray-300 px-3 py-2 pr-10 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              title={showKey ? 'Hide API key' : 'Show API key'}
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600"
            >
              {showKey ? (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg>
              ) : (
                <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
              )}
            </button>
          </div>
        </div>
        <button
          onClick={() => void testConnection()}
          disabled={busy || !base.trim()}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:border-wa hover:bg-green-50 hover:text-wa-dark disabled:opacity-50"
        >
          Test connection
        </button>
      </div>
      )}

      {activeSection === 'agents' && (
      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700">Agents</h3>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-700">Agent identification</p>
            <p className="text-xs text-gray-500">
              Tags every outgoing message with the agent who sent it, using the Google login
              from Cloudflare Access. Agents appear below automatically the first time they
              open the app — who can log in at all is managed in the Cloudflare Access policy.
              Admins see everything; what each agent may do is tuned per agent under “perms”.
            </p>
          </div>
          <Switch on={agentsOn} onToggle={() => setAgentsOn(!agentsOn)} label="Agent identification" />
        </div>
        {agentsOn && <AgentsTable />}
      </div>
      )}

      {activeSection === 'retention' && (
      <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700">Data retention</h3>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-700">Auto-delete old history</p>
            <p className="text-xs text-gray-500">
              Once a day, message attributions, cached message bodies and fired reminders older
              than this many days are deleted automatically. 0 = keep forever.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              step={1}
              value={retention}
              onChange={(e) => setRetention(e.target.value)}
              aria-label="Retention (days, 0 = off)"
              className="w-20 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <span className="text-sm text-gray-500">days</span>
          </div>
        </div>
      </div>
      )}

      {activeSection === 'maintenance' && (
        <div className="space-y-4">
          <ServerHealth />
          <MaintenanceCard />
        </div>
      )}

      {activeSection === 'notifications' && (
        (instancesList.data?.instances?.length ?? 0) >= 1 ? (
          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700">Channels that notify</h3>
            <div>
              <p className="mb-2 text-xs text-gray-400">
                Which WhatsApp lines fire a notification at all — the default channel included. This is
                a shared, operator-level setting; per-person muting lives above. None selected means no
                notifications for anyone.
              </p>
              {notificationsEnabled() && notifyInstances.length === 0 && (
                <p className="mb-2 text-xs text-amber-600">
                  No channels selected — nobody will receive notifications.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {(instancesList.data?.instances ?? []).map((i) => {
                  const def = i.name === instancesList.data?.default;
                  const on = notifyInstances.includes(i.name);
                  return (
                    <label
                      key={i.name}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                        on ? 'border-wa bg-green-50 text-wa-dark' : 'border-gray-200 text-gray-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="accent-wa"
                        checked={on}
                        onChange={(e) =>
                          setNotifyInstances((prev) =>
                            e.target.checked ? [...prev, i.name] : prev.filter((n) => n !== i.name),
                          )
                        }
                      />
                      {i.name}
                      {def && <span className="text-[10px] text-gray-400">(default)</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <p className="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-400 shadow-sm">
            No WhatsApp channels available right now.
          </p>
        )
      )}

      {feedback && (
        <div
          role={feedback.kind === 'err' ? 'alert' : 'status'}
          className={`rounded-lg px-3 py-2 text-sm ${
            feedback.kind === 'ok' ? 'bg-green-50 text-wa-dark' : 'bg-red-50 text-red-600'
          }`}
        >
          {feedback.text}
        </div>
      )}

      <button
        onClick={() => void save()}
        disabled={busy || settings.isLoading}
        className="w-full rounded-lg bg-wa py-2.5 text-sm font-semibold text-white hover:bg-wa-dark disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Save settings'}
      </button>
      </div>
    </div>
  );
}
