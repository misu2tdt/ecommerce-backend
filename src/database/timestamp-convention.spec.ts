import * as pg from 'pg';
import * as pgUtils from 'pg/lib/utils';
import {
  applyTimestampConvention,
  isUtcTimeZoneName,
  parseWallClockAsUtc,
  warnIfSessionTimeZoneIsNotUtc,
} from './timestamp-convention';

interface PgRuntime {
  types: { getTypeParser(oid: number, format: 'text'): (v: string) => unknown };
}
const pgRuntime = pg as unknown as PgRuntime;
const prepareValue = (
  pgUtils as unknown as { prepareValue(value: unknown): string }
).prepareValue;

// These checks hold on any machine: the result does not depend on the zone of the
// process. Running the real payment path under several process zones is the job of
// test/integration/time-convention.integration-spec.ts.
describe('timestamp convention', () => {
  beforeAll(() => applyTimestampConvention());

  it('reads a stored wall clock as UTC, as the pg driver sees it', () => {
    const parse = pgRuntime.types.getTypeParser(1114, 'text');
    expect(parse('2026-11-17 03:00:00')).toEqual(
      new Date('2026-11-17T03:00:00.000Z'),
    );
  });

  it('writes a Date as its UTC wall clock', () => {
    expect(prepareValue(new Date('2026-11-17T03:00:00.000Z'))).toBe(
      '2026-11-17T03:00:00.000+00:00',
    );
  });

  it('keeps milliseconds and drops anything finer', () => {
    expect(parseWallClockAsUtc('2026-11-17 03:00:00.5')).toEqual(
      new Date('2026-11-17T03:00:00.500Z'),
    );
    expect(parseWallClockAsUtc('2026-11-17 03:00:00.123456')).toEqual(
      new Date('2026-11-17T03:00:00.123Z'),
    );
  });

  it('is idempotent and leaves values it does not recognise to the driver', () => {
    applyTimestampConvention();
    applyTimestampConvention();
    expect(parseWallClockAsUtc('infinity')).toBe(Infinity);
  });
});

describe('isUtcTimeZoneName', () => {
  it.each(['UTC', 'Etc/UTC', 'GMT', ' utc ', 'Zulu', 'Etc/GMT'])(
    'accepts %s',
    (name) => expect(isUtcTimeZoneName(name)).toBe(true),
  );
  it.each(['Asia/Ho_Chi_Minh', 'America/Los_Angeles', 'Etc/GMT+7', ''])(
    'rejects "%s"',
    (name) => expect(isUtcTimeZoneName(name)).toBe(false),
  );
});

describe('warnIfSessionTimeZoneIsNotUtc', () => {
  const run = async (zone: string) => {
    const warn = jest.fn();
    await warnIfSessionTimeZoneIsNotUtc(
      { query: jest.fn().mockResolvedValue([{ TimeZone: zone }]) },
      { warn },
    );
    return warn;
  };

  it('stays quiet on UTC and on GMT', async () => {
    expect(await run('UTC')).not.toHaveBeenCalled();
    expect(await run('GMT')).not.toHaveBeenCalled();
  });

  it('warns, naming the zone, for any other zone', async () => {
    const warn = await run('Asia/Ho_Chi_Minh');
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0] as string[])[0]).toContain('Asia/Ho_Chi_Minh');
  });
});
