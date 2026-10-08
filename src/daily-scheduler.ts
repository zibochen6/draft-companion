import { randomUUID } from 'node:crypto';

export const DAILY_LOCAL_KEY = 'draft-companion.daily.local.v1';
interface LocalSchedule {
  enabled: boolean; deviceId: string; handledDate?: string;
  lease?: { owner: string; until: number };
}
export interface DailySchedulerHost {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
  settings(): { time: string; timeZone: 'Asia/Shanghai' };
  enqueue(date: string): Promise<void>;
  changed(): void;
  error(error: unknown): void;
  now?: () => number;
}

/** Calendar dates are calculated explicitly in Shanghai, never in the OS zone. */
export function shanghaiDate(at: number): string { return new Date(at + 8 * 3600_000).toISOString().slice(0, 10); }
export function latestDueDate(at: number, time: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('定时选题时间应为 HH:mm。');
  const date = shanghaiDate(at), scheduled = Date.parse(`${date}T${time}:00+08:00`);
  return shanghaiDate(at < scheduled ? at - 86400_000 : at);
}
export function nextDailyTime(at: number, time: string): number {
  const date = shanghaiDate(at), today = Date.parse(`${date}T${time}:00+08:00`);
  return today > at ? today : today + 86400_000;
}

/** This coordinates windows on this installation; it is not a distributed Sync lock. */
export class DailyTopicScheduler {
  readonly owner = randomUUID();
  private closed = false;
  private ticking = false;
  constructor(private host: DailySchedulerHost) {
    const value = this.host.load(DAILY_LOCAL_KEY) as Partial<LocalSchedule> | undefined;
    if (!value || typeof value.deviceId !== 'string' || typeof value.enabled !== 'boolean')
      this.host.save(DAILY_LOCAL_KEY, { enabled: false, deviceId: randomUUID() });
  }
  private now(): number { return this.host.now?.() ?? Date.now(); }
  private local(): LocalSchedule { return this.host.load(DAILY_LOCAL_KEY) as LocalSchedule; }
  enabled(): boolean { return this.local().enabled === true; }
  setEnabled(enabled: boolean): void {
    this.host.save(DAILY_LOCAL_KEY, { ...this.local(), enabled }); this.host.changed();
    if (enabled) void this.tick();
  }
  claim(): boolean {
    if (this.closed) return false;
    const current = this.local();
    if (current.lease && current.lease.owner !== this.owner && current.lease.until > this.now()) return false;
    this.host.save(DAILY_LOCAL_KEY, { ...current, lease: { owner: this.owner, until: this.now() + 180_000 } });
    return this.local().lease?.owner === this.owner;
  }
  renew(): void {
    const current = this.local();
    if (!this.closed && current.lease?.owner === this.owner)
      this.host.save(DAILY_LOCAL_KEY, { ...current, lease: { owner: this.owner, until: this.now() + 180_000 } });
  }
  assertLease(): void {
    const lease = this.local().lease;
    if (this.closed || lease?.owner !== this.owner || lease.until <= this.now()) throw new Error('另一个窗口已接管选题任务，本次不会写入。');
  }
  release(): void {
    const current = this.local();
    if (current.lease?.owner === this.owner) { delete current.lease; this.host.save(DAILY_LOCAL_KEY, current); }
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking || !this.enabled()) return;
    this.ticking = true;
    try {
      const date = latestDueDate(this.now(), this.host.settings().time), current = this.local();
      if (current.handledDate && current.handledDate >= date) return;
      // Claim the due date before enqueueing; a failed job needs an explicit retry.
      this.host.save(DAILY_LOCAL_KEY, { ...current, handledDate: date });
      await this.host.enqueue(date);
    } catch (error) { this.host.error(error); }
    finally { this.ticking = false; }
  }
  close(): void { this.release(); this.closed = true; }
}
