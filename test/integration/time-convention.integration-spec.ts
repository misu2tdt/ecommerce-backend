import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Node.js reads TZ once, when the process starts, and Jest gives a test its own
// copy of process.env, so a test cannot switch the zone of its own process. This
// spec therefore starts a separate Jest process per zone, with TZ set, and runs
// time-convention.zone-check.ts in it: the real HTTP API, order and payment
// services and expiry job against the test database. Each child must pass.
//
// Before the timestamp convention, the Asia/Ho_Chi_Minh child failed: a payment
// seemed to succeed about seven hours after it was created, and a new unpaid
// order seemed to have expired hours ago.
const ZONES = ['Asia/Ho_Chi_Minh', 'UTC'] as const;
const CHILD_PATTERN = 'test/integration/time-convention\\.zone-check\\.ts$';

describe('the timestamp convention under different Node.js time zones', () => {
  it.each(ZONES)(
    'every time is the real time with the process in %s',
    (zone) => {
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules', 'jest', 'bin', 'jest.js'),
          '--config',
          'test/integration/jest-integration.json',
          '--runInBand',
          '--testRegex',
          CHILD_PATTERN,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TZ: zone, EXPECTED_TZ: zone },
          encoding: 'utf8',
          timeout: 240_000,
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      if (result.status !== 0) {
        throw new Error(
          `The check under TZ=${zone} failed (exit ${String(result.status)}):\n${output.slice(-6000)}`,
        );
      }
      expect(output).toMatch(/Tests:\s+4 passed, 4 total/);
    },
    300_000,
  );
});
