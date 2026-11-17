import { BadRequestException } from '@nestjs/common';
import {
  dayAfter,
  resolveAnalyticsRange,
  validateTimeZone,
} from './analytics-range';

// 09:30 UTC on 17 November 2026 is 16:30 in Vietnam: the same calendar day.
const NOW = new Date('2026-11-17T09:30:00.000Z');

describe('resolveAnalyticsRange', () => {
  it('defaults to the last 30 days ending today, in Asia/Ho_Chi_Minh', () => {
    const { range, previous } = resolveAnalyticsRange({}, NOW);

    expect(range).toEqual({
      from: '2026-10-19',
      to: '2026-11-17',
      days: 30,
      timezone: 'Asia/Ho_Chi_Minh',
    });
    expect(previous).toEqual({
      from: '2026-09-19',
      to: '2026-10-18',
      days: 30,
    });
  });

  it('decides "today" in the requested time zone', () => {
    // 17:30 UTC on 17 November is already 18 November in Vietnam.
    const lateEvening = new Date('2026-11-17T17:30:00.000Z');

    expect(resolveAnalyticsRange({}, lateEvening).range.to).toBe('2026-11-18');
    expect(
      resolveAnalyticsRange({ timezone: 'UTC' }, lateEvening).range.to,
    ).toBe('2026-11-17');
    expect(
      resolveAnalyticsRange({ timezone: 'America/Los_Angeles' }, lateEvening)
        .range.to,
    ).toBe('2026-11-17');
  });

  it('uses both dates as given, both included', () => {
    const { range, previous } = resolveAnalyticsRange(
      { from: '2026-11-01', to: '2026-11-10' },
      NOW,
    );

    expect(range).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-10',
      days: 10,
    });
    expect(previous).toEqual({
      from: '2026-10-22',
      to: '2026-10-31',
      days: 10,
    });
  });

  it('accepts one single day', () => {
    const { range, previous } = resolveAnalyticsRange(
      { from: '2026-11-05', to: '2026-11-05' },
      NOW,
    );

    expect(range.days).toBe(1);
    expect(previous).toEqual({ from: '2026-11-04', to: '2026-11-04', days: 1 });
  });

  it('runs to today when only from is given, and starts 29 days before when only to is', () => {
    expect(
      resolveAnalyticsRange({ from: '2026-11-10' }, NOW).range,
    ).toMatchObject({
      from: '2026-11-10',
      to: '2026-11-17',
      days: 8,
    });
    expect(
      resolveAnalyticsRange({ to: '2026-03-31' }, NOW).range,
    ).toMatchObject({
      from: '2026-03-02',
      to: '2026-03-31',
      days: 30,
    });
  });

  it('finds the previous period across month, year and leap-day boundaries', () => {
    expect(
      resolveAnalyticsRange({ from: '2027-01-01', to: '2027-01-05' }, NOW)
        .previous,
    ).toEqual({ from: '2026-12-27', to: '2026-12-31', days: 5 });
    expect(
      resolveAnalyticsRange({ from: '2028-03-01', to: '2028-03-10' }, NOW)
        .previous,
    ).toEqual({ from: '2028-02-20', to: '2028-02-29', days: 10 });
  });

  it('allows exactly 366 days and refuses 367', () => {
    expect(
      resolveAnalyticsRange({ from: '2026-01-01', to: '2027-01-01' }, NOW).range
        .days,
    ).toBe(366);
    expect(() =>
      resolveAnalyticsRange({ from: '2026-01-01', to: '2027-01-02' }, NOW),
    ).toThrow('at most 366 days');
  });

  it('refuses a from after the to', () => {
    expect(() =>
      resolveAnalyticsRange({ from: '2026-11-10', to: '2026-11-09' }, NOW),
    ).toThrow('from must not be after to');
    // A from in the future runs into the default to (today).
    expect(() => resolveAnalyticsRange({ from: '2026-12-01' }, NOW)).toThrow(
      'from must not be after to',
    );
  });

  it.each([
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '2026-11-31',
    '2026-1-1',
    '26-11-01',
    ' 2026-11-01',
    '2026-11-01T00:00:00Z',
    '2026/11/01',
    '1999-12-31',
    '2101-01-01',
    '',
    'yesterday',
  ])('refuses the date %p', (value) => {
    expect(() =>
      resolveAnalyticsRange({ from: value, to: '2026-11-10' }, NOW),
    ).toThrow(BadRequestException);
    expect(() => resolveAnalyticsRange({ to: value }, NOW)).toThrow(
      BadRequestException,
    );
  });

  it('accepts a real leap day', () => {
    expect(
      resolveAnalyticsRange({ from: '2028-02-29', to: '2028-02-29' }, NOW).range
        .days,
    ).toBe(1);
  });
});

describe('validateTimeZone', () => {
  it.each([
    'Asia/Ho_Chi_Minh',
    'UTC',
    'America/Los_Angeles',
    'Europe/London',
    'Etc/GMT+7',
  ])('accepts %p', (zone) => {
    expect(validateTimeZone(zone)).toBe(zone);
  });

  it.each([
    '',
    '+07:00',
    '07:00',
    'UTC+7',
    'Mars/Olympus',
    'Asia/Ho Chi Minh',
    "UTC'; DROP TABLE orders; --",
    'Asia/../etc',
    'A'.repeat(80),
    '/Asia/Tokyo',
    'Asia//Tokyo',
  ])('refuses %p', (zone) => {
    expect(() => validateTimeZone(zone)).toThrow(BadRequestException);
  });

  it('is applied by resolveAnalyticsRange', () => {
    expect(() => resolveAnalyticsRange({ timezone: '+07:00' }, NOW)).toThrow(
      'IANA time zone name',
    );
  });
});

describe('dayAfter', () => {
  it('moves one calendar day on, across months, years and leap days', () => {
    expect(dayAfter('2026-11-17')).toBe('2026-11-18');
    expect(dayAfter('2026-11-30')).toBe('2026-12-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
    expect(dayAfter('2028-02-28')).toBe('2028-02-29');
    expect(dayAfter('2028-02-29')).toBe('2028-03-01');
    expect(dayAfter('2027-02-28')).toBe('2027-03-01');
  });
});
