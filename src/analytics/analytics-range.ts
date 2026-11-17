import { BadRequestException } from '@nestjs/common';
import {
  DEFAULT_ANALYTICS_TIMEZONE,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
} from './analytics.constants';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// IANA names only ("Asia/Ho_Chi_Minh", "UTC", "Etc/GMT+7"). Offsets such as
// "+07:00" are refused on purpose: PostgreSQL reads them as POSIX zones with the
// opposite sign, which would silently shift every day by hours.
const TIMEZONE_PATTERN =
  /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*){0,2}$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export interface AnalyticsRangeInput {
  from?: string;
  to?: string;
  timezone?: string;
}

// A whole number of calendar days, both ends included, as dates in `timezone`.
export interface DateSpan {
  from: string;
  to: string;
  days: number;
}

export interface AnalyticsRange extends DateSpan {
  timezone: string;
}

export interface ResolvedRange {
  range: AnalyticsRange;
  // The period of the same length that ends the day before `range` starts.
  previous: DateSpan;
}

// Turns the query into a validated range. `from` and `to` are calendar dates
// (YYYY-MM-DD) in the requested time zone, both included, so one day is
// from = to. Left out, the range is the last 30 days ending today (in that zone);
// only `from` runs to today, only `to` starts 29 days before it. A range is at
// most 366 days and `from` may not be after `to`.
export function resolveAnalyticsRange(
  input: AnalyticsRangeInput,
  now: Date = new Date(),
): ResolvedRange {
  const timezone = validateTimeZone(
    input.timezone ?? DEFAULT_ANALYTICS_TIMEZONE,
  );

  const to = input.to ?? undefined;
  const from = input.from ?? undefined;
  const toDay = to === undefined ? undefined : parseDay(to, 'to');
  const fromDay = from === undefined ? undefined : parseDay(from, 'from');

  const resolvedTo = toDay ?? today(timezone, now);
  const resolvedFrom = fromDay ?? resolvedTo - (DEFAULT_RANGE_DAYS - 1);

  if (resolvedFrom > resolvedTo) {
    throw new BadRequestException('from must not be after to');
  }
  const days = resolvedTo - resolvedFrom + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `The range is ${days} days; at most ${MAX_RANGE_DAYS} days are allowed`,
    );
  }

  const previousTo = resolvedFrom - 1;
  return {
    range: {
      from: formatDay(resolvedFrom),
      to: formatDay(resolvedTo),
      days,
      timezone,
    },
    previous: {
      from: formatDay(previousTo - (days - 1)),
      to: formatDay(previousTo),
      days,
    },
  };
}

// The day after a calendar date, as the exclusive end of a range.
export function dayAfter(date: string): string {
  return formatDay(parseDay(date, 'date') + 1);
}

export function validateTimeZone(value: string): string {
  const message =
    'timezone must be an IANA time zone name such as Asia/Ho_Chi_Minh or UTC';
  if (typeof value !== 'string' || !TIMEZONE_PATTERN.test(value)) {
    throw new BadRequestException(message);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new BadRequestException(message);
  }
  return value;
}

// A calendar day as a number of days since 1970-01-01 (so days add and subtract
// without any time zone or daylight saving).
function parseDay(value: string, name: string): number {
  const invalid = new BadRequestException(
    `${name} must be a real calendar date in the form YYYY-MM-DD`,
  );
  const match = DATE_PATTERN.exec(value);
  if (!match) throw invalid;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  if (year < MIN_YEAR || year > MAX_YEAR) throw invalid;
  const milliseconds = Date.UTC(year, month - 1, day);
  const check = new Date(milliseconds);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw invalid;
  }
  return milliseconds / DAY_MS;
}

function formatDay(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

// Today's calendar date in a time zone.
function today(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parseDay(parts, 'today');
}
