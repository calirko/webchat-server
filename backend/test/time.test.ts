import { describe, expect, it } from 'vitest';
import { inQuietHours, messageTimeMs } from '../src/services/time.js';

describe('inQuietHours', () => {
  it('handles same-day and overnight windows', () => {
    const at = (h: number, m = 0) => new Date(2026, 5, 19, h, m);
    expect(inQuietHours(at(13), '12:00', '14:00')).toBe(true);
    expect(inQuietHours(at(14), '12:00', '14:00')).toBe(false);
    expect(inQuietHours(at(23), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at(7, 59), '21:00', '08:00')).toBe(true);
    expect(inQuietHours(at(8), '21:00', '08:00')).toBe(false);
  });

  it('treats malformed or empty windows as never quiet', () => {
    const now = new Date(2026, 5, 19, 23);
    expect(inQuietHours(now, '', '08:00')).toBe(false);
    expect(inQuietHours(now, '25:00', '08:00')).toBe(false);
    expect(inQuietHours(now, '08:00', '08:00')).toBe(false);
  });
});

describe('messageTimeMs', () => {
  it('normalizes seconds, millis, numeric strings and protobuf Longs', () => {
    expect(messageTimeMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(messageTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(messageTimeMs('1700000000')).toBe(1_700_000_000_000);
    expect(messageTimeMs({ low: 1_700_000_000, high: 0 })).toBe(1_700_000_000_000);
  });

  it('returns null for missing or invalid input', () => {
    expect(messageTimeMs(undefined)).toBeNull();
    expect(messageTimeMs('')).toBeNull();
    expect(messageTimeMs(0)).toBeNull();
    expect(messageTimeMs('abc')).toBeNull();
  });
});
