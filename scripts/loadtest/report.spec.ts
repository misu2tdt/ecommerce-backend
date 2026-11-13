import { formatMs, formatRate, percentile } from './stats';
import {
  formatReport,
  runPassed,
  scenarioPassed,
  standardChecks,
  summariseBurst,
  tally,
  unexpectedNotes,
  type Burst,
  type RequestRecord,
  type RunReport,
  type ScenarioReport,
} from './report';
import { DEFAULT_OPTIONS } from './args';

function record(
  kind: RequestRecord['kind'],
  ms: number,
  status = 200,
  extra: Partial<RequestRecord> = {},
): RequestRecord {
  return { kind, ms, status, ...extra };
}

const burst: Burst = {
  label: 'burst | one',
  wallMs: 2000,
  records: [
    record('success', 10),
    record('success', 20),
    record('expected_refusal', 30, 400),
    record('expected_refusal', 40, 400),
    record('unexpected', 100, 500, { note: '500 boom' }),
    record('throttled', 50, 429),
  ],
};

function scenario(overrides: Partial<ScenarioReport> = {}): ScenarioReport {
  return {
    id: 1,
    title: 'Oversell',
    proves: 'Nothing is sold twice.',
    bursts: [burst],
    checks: [{ label: 'Final stock is 0', passed: true, detail: 'stock 0' }],
    notes: ['A note.'],
    ...overrides,
  };
}

function runReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    startedAt: '2026-11-12T08:00:00.000Z',
    durationMs: 45_000,
    machine: {
      os: 'Windows_NT 10.0 (x64)',
      cpu: 'Test CPU',
      cpuCount: 8,
      memoryGb: 16,
      node: 'v22.0.0',
      postgres: 'PostgreSQL 16.4',
    },
    options: DEFAULT_OPTIONS,
    scenarios: [scenario()],
    cleanup: {
      ok: true,
      removed: { customers: 200 },
      problems: [],
      seededRowsUnchanged: true,
    },
    backendStopped: true,
    ...overrides,
  };
}

describe('statistics', () => {
  it('uses the nearest-rank percentile', () => {
    const values = [50, 10, 40, 20, 30];
    expect(percentile(values, 50)).toBe(30);
    expect(percentile(values, 95)).toBe(50);
    expect(percentile(values, 0)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it('does not reorder the values it is given', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });

  it('formats times and rates', () => {
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatMs(2500)).toBe('2.50 s');
    expect(formatMs(null)).toBe('n/a');
    expect(formatRate(200, 2000)).toBe('100.0/s');
    expect(formatRate(5, 0)).toBe('n/a');
  });
});

describe('burst summary', () => {
  it('counts every kind of answer separately', () => {
    expect(summariseBurst(burst)).toEqual({
      label: 'burst | one',
      requests: 6,
      successes: 2,
      expectedRefusals: 2,
      unexpected: 1,
      throttled: 1,
      serverErrors: 1,
      p50: 30,
      p95: 100,
      wallMs: 2000,
    });
  });

  it('tallies tags in a stable order', () => {
    const counts = tally([
      record('success', 1, 200, { tag: 'b' }),
      record('success', 1, 200, { tag: 'a' }),
      record('success', 1, 200, { tag: 'b' }),
      record('success', 1),
    ]);
    expect([...counts]).toEqual([
      ['(untagged)', 1],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('lists the most common unexpected reasons first', () => {
    const notes = unexpectedNotes([
      {
        label: 'x',
        wallMs: 1,
        records: [
          record('unexpected', 1, 500, { note: 'rare' }),
          record('unexpected', 1, 500, { note: 'common' }),
          record('unexpected', 1, 500, { note: 'common' }),
          record('unexpected', 1, 502),
          record('success', 1),
        ],
      },
    ]);
    expect(notes).toEqual([
      'Unexpected response (2x): common',
      'Unexpected response (1x): rare',
      'Unexpected response (1x): status 502',
    ]);
  });
});

describe('verdicts', () => {
  it('standard checks fail on unexpected answers, 429 and 5xx', () => {
    const checks = standardChecks([burst]);
    expect(checks.map((check) => check.passed)).toEqual([false, false, false]);
    expect(checks[1].label).toContain('setup problem');

    const clean = standardChecks([
      { label: 'ok', wallMs: 1, records: [record('success', 1)] },
    ]);
    expect(clean.every((check) => check.passed)).toBe(true);
  });

  it('a scenario passes only if it ran and every check passed', () => {
    expect(scenarioPassed(scenario())).toBe(true);
    expect(
      scenarioPassed(
        scenario({
          checks: [{ label: 'x', passed: false, detail: '' }],
        }),
      ),
    ).toBe(false);
    expect(scenarioPassed(scenario({ checks: [] }))).toBe(false);
    expect(scenarioPassed(scenario({ setupError: 'boom' }))).toBe(false);
  });

  it('a run passes only with passing scenarios, a clean database and a stopped backend', () => {
    expect(runPassed(runReport())).toBe(true);
    expect(runPassed(runReport({ backendStopped: false }))).toBe(false);
    expect(
      runPassed(
        runReport({
          cleanup: {
            ok: false,
            removed: {},
            problems: ['x'],
            seededRowsUnchanged: null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      runPassed(
        runReport({
          scenarios: [scenario({ setupError: 'boom', checks: [] })],
        }),
      ),
    ).toBe(false);
  });
});

describe('Markdown report', () => {
  it('states clearly that the numbers are local and not a benchmark', () => {
    const text = formatReport(runReport());
    expect(text).toContain('local numbers from one laptop');
    expect(text).toContain('not a');
    expect(text).toContain('production benchmark');
  });

  it('lists the machine, the parameters and the verdict', () => {
    const text = formatReport(runReport());
    expect(text).toContain('| Date (UTC) | 2026-11-12T08:00:00.000Z |');
    expect(text).toContain('| Node.js | v22.0.0 |');
    expect(text).toContain('| PostgreSQL | PostgreSQL 16.4 |');
    expect(text).toContain('Test CPU (8 logical CPUs)');
    expect(text).toContain('customers 200, stock 10');
    expect(text).toContain('Result of the run: **PASS**');
  });

  it('prints one row of figures per burst, with pipes escaped', () => {
    const text = formatReport(runReport());
    expect(text).toContain(
      '| burst \\| one | 6 | 2 | 2 | 1 | 1 | 30.0 ms | 100.0 ms | 2.00 s | 3.0/s |',
    );
    expect(text).toContain('| Final stock is 0 | PASS | stock 0 |');
    expect(text).toContain('- A note.');
  });

  it('marks failures and unfinished scenarios', () => {
    const text = formatReport(
      runReport({
        scenarios: [
          scenario({
            checks: [
              { label: 'Final stock is 0', passed: false, detail: 'stock 2' },
            ],
          }),
          scenario({
            id: 2,
            title: 'Broken',
            setupError: 'no backend',
            checks: [],
            bursts: [],
          }),
        ],
        backendStopped: false,
      }),
    );
    expect(text).toContain('Result of the run: **FAIL**');
    expect(text).toContain('## 1. Oversell: FAIL');
    expect(text).toContain('| Final stock is 0 | FAIL | stock 2 |');
    expect(text).toContain('The scenario could not run: no backend');
    expect(text).toContain('| Backend process stopped | NO |');
  });

  it('reports the clean-up and any problem', () => {
    const text = formatReport(
      runReport({
        cleanup: {
          ok: false,
          removed: {},
          problems: ['Rows are still present after clean-up.'],
          seededRowsUnchanged: false,
        },
      }),
    );
    expect(text).toContain('| Rows created by the run removed | NO |');
    expect(text).toContain('| Seeded demo rows unchanged | NO |');
    expect(text).toContain('- Rows are still present after clean-up.');
  });
});
