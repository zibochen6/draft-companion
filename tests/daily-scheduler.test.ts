import { describe, expect, it, vi } from 'vitest';
import { DAILY_LOCAL_KEY, DailyTopicScheduler, latestDueDate, nextDailyTime, shanghaiDate, type DailySchedulerHost } from '../src/daily-scheduler';

function fixture(at = Date.parse('2026-10-08T01:00:00Z')) {
  const local = new Map<string, unknown>(); let now = at, time = '09:00';
  const enqueue = vi.fn(async (_date: string) => {}), error = vi.fn(), changed = vi.fn();
  const host: DailySchedulerHost = { load: key => structuredClone(local.get(key)), save: (key, value) => { local.set(key, structuredClone(value)); },
    settings: () => ({ time, timeZone: 'Asia/Shanghai' }), enqueue, error, changed, now: () => now };
  const scheduler = new DailyTopicScheduler(host);
  return { local, host, scheduler, enqueue, error, changed, setNow: (value: number) => { now = value; }, setTime: (value: string) => { time = value; } };
}

describe('Shanghai daily scheduler', () => {
  it('uses Shanghai calendar dates across UTC day boundaries', () => {
    expect(shanghaiDate(Date.parse('2026-10-07T16:00:00Z'))).toBe('2026-10-08');
    expect(shanghaiDate(Date.parse('2026-10-07T15:59:59Z'))).toBe('2026-10-07');
    expect(latestDueDate(Date.parse('2026-10-08T00:59:59Z'), '09:00')).toBe('2026-10-07');
    expect(latestDueDate(Date.parse('2026-10-08T01:00:00Z'), '09:00')).toBe('2026-10-08');
    expect(nextDailyTime(Date.parse('2026-10-08T00:59:59Z'), '09:00')).toBe(Date.parse('2026-10-08T01:00:00Z'));
    expect(nextDailyTime(Date.parse('2026-10-08T01:00:00Z'), '09:00')).toBe(Date.parse('2026-10-09T01:00:00Z'));
    expect(() => latestDueDate(Date.now(), '9:00')).toThrow('HH:mm');
  });
  it('starts disabled locally and never queues while disabled', async () => {
    const f = fixture(); expect(f.scheduler.enabled()).toBe(false); await f.scheduler.tick(); expect(f.enqueue).not.toHaveBeenCalled();
    const value = f.local.get(DAILY_LOCAL_KEY) as { enabled: boolean; deviceId: string };
    expect(value.deviceId).toBeTruthy(); expect(value.enabled).toBe(false);
  });
  it('enabling queues exactly the most recent due day and repeated ticks do not duplicate it', async () => {
    const f = fixture(); f.scheduler.setEnabled(true); await f.scheduler.tick();
    await f.scheduler.tick(); await f.scheduler.tick(); expect(f.enqueue.mock.calls).toEqual([['2026-10-08']]);
    expect(f.changed).toHaveBeenCalledOnce();
    f.setNow(Date.parse('2026-10-09T01:00:00Z')); await f.scheduler.tick(); expect(f.enqueue.mock.calls).toEqual([['2026-10-08'], ['2026-10-09']]);
  });
  it('after a long closure catches up only the latest due day', async () => {
    const f = fixture(); f.scheduler.setEnabled(true); await f.scheduler.tick();
    f.setNow(Date.parse('2026-10-20T05:00:00Z')); await f.scheduler.tick();
    expect(f.enqueue.mock.calls).toEqual([['2026-10-08'], ['2026-10-20']]);
    f.scheduler.setEnabled(false); f.setNow(Date.parse('2026-10-30T05:00:00Z')); await f.scheduler.tick(); expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it('before the configured time catches up yesterday once and queues today when due', async () => {
    const f = fixture(Date.parse('2026-10-08T00:00:00Z')); f.scheduler.setEnabled(true); await f.scheduler.tick();
    expect(f.enqueue.mock.calls).toEqual([['2026-10-07']]);
    f.setNow(Date.parse('2026-10-08T01:00:00Z')); await f.scheduler.tick(); expect(f.enqueue.mock.calls).toEqual([['2026-10-07'], ['2026-10-08']]);
  });
  it('prevents overlapping ticks while enqueue is pending and retains local state across instances', async () => {
    const f = fixture(); let release!: () => void; f.enqueue.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    f.scheduler.setEnabled(true); await f.scheduler.tick();
    const second = new DailyTopicScheduler(f.host); await second.tick(); expect(f.enqueue).toHaveBeenCalledOnce();
    release(); await Promise.resolve(); await f.scheduler.tick(); expect(f.enqueue).toHaveBeenCalledOnce();
    expect(second.enabled()).toBe(true);
  });
  it('holds a window lease, renews it, and permits takeover only after expiry', () => {
    const f = fixture(), other = new DailyTopicScheduler(f.host);
    expect(f.scheduler.claim()).toBe(true); expect(other.claim()).toBe(false); expect(() => f.scheduler.assertLease()).not.toThrow();
    f.setNow(Date.parse('2026-10-08T01:02:00Z')); f.scheduler.renew();
    f.setNow(Date.parse('2026-10-08T01:04:00Z')); expect(other.claim()).toBe(false);
    f.setNow(Date.parse('2026-10-08T01:05:01Z')); expect(other.claim()).toBe(true); expect(() => f.scheduler.assertLease()).toThrow('接管');
    f.scheduler.release(); expect(() => other.assertLease()).not.toThrow(); other.release(); expect(f.scheduler.claim()).toBe(true);
  });
  it('closing releases only its own lease and disables future scheduling', async () => {
    const f = fixture(); expect(f.scheduler.claim()).toBe(true); f.scheduler.close();
    expect((f.local.get(DAILY_LOCAL_KEY) as { lease?: unknown }).lease).toBeUndefined();
    f.scheduler.setEnabled(true); await f.scheduler.tick(); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.scheduler.claim()).toBe(false);
  });
  it('records an enqueue failure without automatically retrying that due date', async () => {
    const f = fixture(); f.enqueue.mockRejectedValue(new Error('缺少模型')); f.scheduler.setEnabled(true); await Promise.resolve(); await Promise.resolve(); await f.scheduler.tick();
    expect(f.enqueue).toHaveBeenCalledOnce(); expect(f.error).toHaveBeenCalledOnce();
    f.setNow(Date.parse('2026-10-09T01:00:00Z')); await f.scheduler.tick(); expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it('repairs malformed local state without changing plugin-synced data', () => {
    const f = fixture(); f.local.set(DAILY_LOCAL_KEY, { enabled: 'yes', deviceId: 123 });
    const scheduler = new DailyTopicScheduler(f.host); expect(scheduler.enabled()).toBe(false);
    expect(Object.keys(f.local.get(DAILY_LOCAL_KEY) as object).sort()).toEqual(['deviceId', 'enabled']);
  });
});
