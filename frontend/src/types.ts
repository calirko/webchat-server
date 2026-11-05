// Mirrors backend/src/types.ts — the /api wire contract.

/** One outgoing message: `type` picks the Evolution endpoint (backend messages.ts). */
export interface MessageItem {
  type: string;
  data: Record<string, unknown>;
}

export type AgentRole = 'admin' | 'agent';

export type PermissionKey = 'settings.manage' | 'agents.manage';

export type Perms = Record<PermissionKey, boolean>;

/** A sales agent, auto-provisioned from the Cloudflare Access Google login. */
export interface Agent {
  email: string;
  name: string;
  color: string;
  active: boolean;
  role: AgentRole;
  /** Explicit grants/denies stored on the agent (a diff over role defaults). */
  perms: Partial<Perms>;
  /** The resolved permission map the server enforces. */
  effectivePerms: Perms;
  /** Evolution instance grants; null/empty = the Settings default only. */
  instances: string[] | null;
  /**
   * The synthetic AI sender rather than a person. The server already keeps it
   * out of GET /api/agents, so this is only ever false here — it exists so any
   * roster/picker code that grows a new source stays explicit about it.
   */
  isBot?: boolean;
  createdAt: string;
  lastSeenAt: string;
}

/** The signed-in agent (GET /api/me). email is null while the toggle is off. */
export interface Me {
  enabled: boolean;
  email: string | null;
  name: string;
  color: string;
  /** null = no Access identity (toggle off / LAN) → unrestricted. */
  role: AgentRole | null;
  /** Effective permissions; null = unrestricted (mirrors the server). */
  perms: Perms | null;
  /** Instances this agent may use; null = all of them. */
  instances: string[] | null;
  /** The Settings default instance. */
  defaultInstance: string;
}

/** One Evolution instance as served by GET /api/instances. */
export interface InstanceInfo {
  name: string;
  connectionStatus: string;
  profileName: string;
  number: string;
  /** insights.view holders only — the storage telemetry. */
  counts?: { messages: number; contacts: number; chats: number } | null;
  disconnectedAt?: string | null;
}

export interface MaintenanceReport {
  disk: { totalBytes: number; freeBytes: number } | null;
  db: { sizeBytes: number; walBytes: number };
  tables: Record<string, number>;
  statsSince: string | null;
  evolution: Array<{
    name: string;
    connectionStatus: string;
    counts: { messages: number; contacts: number; chats: number } | null;
    disconnectedAt: string | null;
  }> | null;
  evolutionError: string | null;
  retentionDays: number;
  defaultInstance: string;
}

export interface CleanupResult {
  dryRun: boolean;
  olderThanDays: number;
  jobs: number;
  sends: number;
  outboundSends: number;
  messageAgents: number;
  messageCache: number;
  messageEdits: number;
  reminders: number;
  bytesBefore: number;
  bytesAfter: number;
  vacuumed: boolean;
  note?: string;
}

/** Evolution message id → agent, for chat-bubble badges. */
export interface AgentTag {
  email: string;
  name: string;
  color: string;
}

/** message id → who sent it (badge) and, when touched via the app, who deleted/edited it. */
export type MessageAgents = Record<
  string,
  AgentTag & { deletedBy?: AgentTag; deletedAt?: string; editedBy?: AgentTag }
>;

// ---- v2.8 agent workbench ------------------------------------------------

export type ChatWorkStatus = 'open' | 'pending' | 'resolved';

export interface ChatMeta {
  assignments: Record<string, { agentEmail: string; assignedBy: string; assignedAt: string }>;
  statuses: Record<string, { status: ChatWorkStatus; changedBy: string; changedAt: string }>;
  tags: Record<string, string[]>;
  allTags: string[];
  /** alt jid → canonical jid (the key chat meta rows are stored under). */
  aliases: Record<string, string>;
}

export interface ChatNote {
  id: number;
  chatJid: string;
  agentEmail: string;
  body: string;
  createdAt: string;
}

export interface Reminder {
  id: number;
  chatJid: string;
  agentEmail: string;
  dueAt: string;
  note: string;
  status: 'pending' | 'fired' | 'dismissed';
  createdAt: string;
}

/** One agent viewing/typing in a chat right now (AGENT_PRESENCE event). */
export interface AgentPresenceEntry {
  email: string;
  chatJid: string;
  typing: boolean;
}

export interface SendResult {
  ok: boolean;
  routed: 'evo';
  skipped: false;
  /** Evolution message id of the sent message; null when unavailable. Lets the client reconcile an optimistic bubble by id. */
  messageId?: string | null;
}

/** Evolution chat/message records pass through the gateway loosely typed. */
export type EvoChat = Record<string, any>;
export type EvoMessage = Record<string, any>;
