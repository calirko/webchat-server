/** Seam for follow-up reminders (RemindersStore in production). */
export interface ReminderSource {
  fireDue(now?: Date): Array<{ id: number; chatJid: string; agentEmail: string; note: string }>;
}

/**
 * The app's one background poll: fires due follow-up reminders over SSE and
 * runs the retention sweep at most once per (UTC) day. Both used to ride the
 * campaign scheduler's tick; with campaigns gone this is all that's left.
 */
export class Housekeeping {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSweepDay = '';

  constructor(
    private readonly opts: {
      pollMs: number;
      reminders: ReminderSource;
      emit: (event: string, data: unknown) => void;
      /** Daily retention sweep — invoked at most once per day. */
      retentionSweep: () => void;
      log?: (msg: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
    this.tick(); // catch up immediately on boot
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(now: Date = new Date()): void {
    const log = this.opts.log ?? (() => {});
    try {
      for (const r of this.opts.reminders.fireDue(now)) {
        this.opts.emit('REMINDER_DUE', {
          id: r.id,
          chatJid: r.chatJid,
          agentEmail: r.agentEmail,
          note: r.note,
        });
        log(`[reminder ${r.id}] fired for ${r.agentEmail || 'everyone'} on ${r.chatJid}`);
      }
    } catch (e) {
      log(`[reminders] error: ${String(e)}`);
    }
    const today = now.toISOString().slice(0, 10);
    if (this.lastSweepDay === today) return;
    this.lastSweepDay = today;
    try {
      this.opts.retentionSweep();
    } catch (e) {
      log(`[retention] sweep error: ${String(e)}`);
    }
  }
}
