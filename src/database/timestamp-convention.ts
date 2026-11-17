import { Logger } from '@nestjs/common';
import * as pg from 'pg';
import type { DataSource } from 'typeorm';

// The timestamp convention of this API.
//
// Almost every time column is "timestamp WITHOUT time zone". The database fills
// createdAt / updatedAt with now() in its session time zone, and the application
// writes the rest with now() too (succeededAt, processedAt, resolvedAt), so ONE
// clock, the database's, produces every stored time stamp.
//
// What is left is how the Node.js driver turns such a column into a Date and a
// Date into a column. By default it uses the time zone of the Node.js process in
// both directions, so a process in Vietnam reading a database that runs on UTC
// reports every time seven hours early. These two settings make both directions
// independent of the process time zone: a stored wall clock is read, and a Date
// is written, as UTC.
//
// That is only the right reading when the database session runs on UTC (the
// default of Docker's postgres image and of Neon). warnIfSessionTimeZoneIsNotUtc
// says so at startup when it does not. No connection option is used to force the
// zone, because a pooled endpoint may reject start-up options.
//
// Coupon windows (startsAt, endsAt) are already "timestamp with time zone" and
// need none of this.
//
// A later step is to move the columns to "timestamp with time zone". That needs a
// migration and is a separate decision.

const TIMESTAMP_WITHOUT_TIME_ZONE = 1114;
const WALL_CLOCK =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

interface PgRuntime {
  defaults: { parseInputDatesAsUTC: boolean };
  types: {
    getTypeParser(oid: number, format: 'text'): (value: string) => unknown;
    setTypeParser(oid: number, parser: (value: string) => unknown): void;
  };
}

const runtime = pg as unknown as PgRuntime;
let driverParser: ((value: string) => unknown) | undefined;

// "2026-11-17 03:00:00.123456" is the instant 2026-11-17T03:00:00.123Z.
export function parseWallClockAsUtc(value: string): unknown {
  const match = WALL_CLOCK.exec(value);
  if (!match) {
    // "infinity", years before 1000 and so on: the driver's own reading.
    return driverParser ? driverParser(value) : value;
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(fraction.padEnd(3, '0').slice(0, 3)),
    ),
  );
}

// Idempotent: safe to call from every place that builds a data source.
export function applyTimestampConvention(): void {
  driverParser ??= runtime.types.getTypeParser(
    TIMESTAMP_WITHOUT_TIME_ZONE,
    'text',
  );
  runtime.defaults.parseInputDatesAsUTC = true;
  runtime.types.setTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE, parseWallClockAsUtc);
}

const UTC_ZONE_NAMES = new Set([
  'utc',
  'etc/utc',
  'gmt',
  'etc/gmt',
  'etc/gmt+0',
  'etc/gmt-0',
  'etc/gmt0',
  'gmt0',
  'gmt+0',
  'gmt-0',
  'greenwich',
  'etc/greenwich',
  'uct',
  'etc/uct',
  'zulu',
  'etc/zulu',
  'universal',
  'etc/universal',
]);

export function isUtcTimeZoneName(name: string): boolean {
  return UTC_ZONE_NAMES.has(name.trim().toLowerCase());
}

export async function warnIfSessionTimeZoneIsNotUtc(
  dataSource: Pick<DataSource, 'query'>,
  logger: Pick<Logger, 'warn'> = new Logger('Database'),
): Promise<void> {
  const rows =
    await dataSource.query<Array<{ TimeZone: string }>>('SHOW TimeZone');
  const zone = rows[0]?.TimeZone;
  if (zone && !isUtcTimeZoneName(zone)) {
    logger.warn(
      `The database session time zone is ${zone}, not UTC. Stored times are read as UTC, so the times in API answers will be shifted. Set the time zone of the database or role to UTC.`,
    );
  }
}
