// Result types and the Markdown report of the concurrency check. Pure: every
// figure printed comes from the records handed in, nothing is made up here.

import type { LoadTestOptions } from './args';
import { formatMs, formatRate, percentile } from './stats';

export type RequestKind =
  | 'success'
  | 'expected_refusal'
  | 'throttled'
  | 'unexpected';

export interface RequestRecord {
  kind: RequestKind;
  /** HTTP status, or 0 when no response arrived (network error, timeout). */
  status: number;
  ms: number;
  /** Short label such as "applied"; used for tallies. */
  tag?: string;
  /** Why the response was unexpected. */
  note?: string;
}

export interface Burst {
  label: string;
  records: RequestRecord[];
  wallMs: number;
}

export interface BurstSummary {
  label: string;
  requests: number;
  successes: number;
  expectedRefusals: number;
  unexpected: number;
  throttled: number;
  serverErrors: number;
  p50: number | null;
  p95: number | null;
  wallMs: number;
}

export interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ScenarioReport {
  id: number;
  title: string;
  proves: string;
  bursts: Burst[];
  checks: Check[];
  notes: string[];
  /** Set when the scenario could not run at all. */
  setupError?: string;
}

export interface MachineInfo {
  os: string;
  cpu: string;
  cpuCount: number;
  memoryGb: number;
  node: string;
  postgres: string;
}

export interface CleanupReport {
  ok: boolean;
  removed: Record<string, number>;
  problems: string[];
  seededRowsUnchanged: boolean | null;
}

export interface RunReport {
  startedAt: string;
  durationMs: number;
  machine: MachineInfo;
  options: LoadTestOptions;
  scenarios: ScenarioReport[];
  cleanup: CleanupReport;
  backendStopped: boolean;
}

export function summariseBurst(burst: Burst): BurstSummary {
  const count = (kind: RequestKind) =>
    burst.records.filter((record) => record.kind === kind).length;
  const latencies = burst.records.map((record) => record.ms);
  return {
    label: burst.label,
    requests: burst.records.length,
    successes: count('success'),
    expectedRefusals: count('expected_refusal'),
    unexpected: count('unexpected'),
    throttled: count('throttled'),
    serverErrors: burst.records.filter((record) => record.status >= 500).length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    wallMs: burst.wallMs,
  };
}

/** Counts how many records carry each tag, in a stable order. */
export function tally(records: readonly RequestRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const tag = record.tag ?? '(untagged)';
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** The most common reasons for unexpected answers, as note lines. */
export function unexpectedNotes(bursts: readonly Burst[], limit = 5): string[] {
  const reasons = new Map<string, number>();
  for (const burst of bursts) {
    for (const record of burst.records) {
      if (record.kind !== 'unexpected') continue;
      const reason = record.note ?? `status ${record.status}`;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return [...reasons.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([reason, count]) => `Unexpected response (${count}x): ${reason}`);
}

/** Checks every scenario gets: no unexpected answer, no 429, no 5xx. */
export function standardChecks(bursts: readonly Burst[]): Check[] {
  const summaries = bursts.map(summariseBurst);
  const total = (pick: (summary: BurstSummary) => number) =>
    summaries.reduce((sum, summary) => sum + pick(summary), 0);
  const unexpected = total((summary) => summary.unexpected);
  const throttled = total((summary) => summary.throttled);
  const serverErrors = total((summary) => summary.serverErrors);
  return [
    {
      label: 'No unexpected responses',
      passed: unexpected === 0,
      detail: `${unexpected} unexpected of ${total((s) => s.requests)} requests`,
    },
    {
      label: 'No 429 (a 429 is a setup problem, not a pass)',
      passed: throttled === 0,
      detail: `${throttled} throttled`,
    },
    {
      label: 'No 5xx responses',
      passed: serverErrors === 0,
      detail: `${serverErrors} server errors`,
    },
  ];
}

export function scenarioPassed(scenario: ScenarioReport): boolean {
  return (
    scenario.setupError === undefined &&
    scenario.checks.length > 0 &&
    scenario.checks.every((check) => check.passed)
  );
}

export function runPassed(report: RunReport): boolean {
  return (
    report.scenarios.every(scenarioPassed) &&
    report.cleanup.ok &&
    report.backendStopped
  );
}

function cell(text: string | number): string {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function verdict(passed: boolean): string {
  return passed ? 'PASS' : 'FAIL';
}

export function formatBurstTable(bursts: readonly Burst[]): string {
  return table(
    [
      'Burst',
      'Requests',
      'Successes',
      'Expected refusals',
      'Unexpected',
      '429',
      'p50',
      'p95',
      'Wall time',
      'Throughput',
    ],
    bursts.map((burst) => {
      const s = summariseBurst(burst);
      return [
        s.label,
        s.requests,
        s.successes,
        s.expectedRefusals,
        s.unexpected,
        s.throttled,
        formatMs(s.p50),
        formatMs(s.p95),
        formatMs(s.wallMs),
        formatRate(s.requests, s.wallMs),
      ];
    }),
  );
}

export function formatScenario(scenario: ScenarioReport): string {
  const parts: string[] = [
    `## ${scenario.id}. ${scenario.title}: ${verdict(scenarioPassed(scenario))}`,
    '',
    scenario.proves,
    '',
  ];
  if (scenario.setupError) {
    parts.push(`The scenario could not run: ${scenario.setupError}`, '');
  }
  if (scenario.bursts.length > 0) {
    parts.push(formatBurstTable(scenario.bursts), '');
  }
  if (scenario.checks.length > 0) {
    parts.push(
      table(
        ['Check', 'Result', 'Detail'],
        scenario.checks.map((check) => [
          check.label,
          verdict(check.passed),
          check.detail,
        ]),
      ),
      '',
    );
  }
  for (const note of scenario.notes) parts.push(`- ${note}`);
  if (scenario.notes.length > 0) parts.push('');
  return parts.join('\n');
}

export function formatReport(report: RunReport): string {
  const { machine, options } = report;
  const lines: string[] = [
    '# Load test results',
    '',
    '> These are **local numbers from one laptop against an isolated test',
    '> database**, with the demo payment provider. They show that the ordering and',
    '> payment guarantees hold under concurrent requests. They are not a',
    '> production benchmark and say nothing about capacity. See',
    '> [concurrency-check.md](concurrency-check.md) for what each scenario proves',
    '> and its limits.',
    '',
    `Result of the run: **${verdict(runPassed(report))}**`,
    '',
    table(
      ['Item', 'Value'],
      [
        ['Date (UTC)', report.startedAt],
        ['Run time', formatMs(report.durationMs)],
        ['OS', machine.os],
        ['CPU', `${machine.cpu} (${machine.cpuCount} logical CPUs)`],
        ['Memory', `${machine.memoryGb} GB`],
        ['Node.js', machine.node],
        ['PostgreSQL', machine.postgres],
        [
          'Parameters',
          `customers ${options.customers}, stock ${options.stock}, parallel requests ${options.parallel}, orders per payment scenario ${options.orders}`,
        ],
      ],
    ),
    '',
    '## Summary',
    '',
    table(
      ['#', 'Scenario', 'Result', 'Requests', 'Unexpected', '429', 'Wall time'],
      report.scenarios.map((scenario) => {
        const summaries = scenario.bursts.map(summariseBurst);
        const sum = (pick: (s: BurstSummary) => number) =>
          summaries.reduce((total, s) => total + pick(s), 0);
        return [
          scenario.id,
          scenario.title,
          verdict(scenarioPassed(scenario)),
          sum((s) => s.requests),
          sum((s) => s.unexpected),
          sum((s) => s.throttled),
          formatMs(sum((s) => s.wallMs)),
        ];
      }),
    ),
    '',
    ...report.scenarios.map((scenario) => formatScenario(scenario)),
    '## Clean-up',
    '',
    table(
      ['Item', 'Result'],
      [
        ['Backend process stopped', report.backendStopped ? 'yes' : 'NO'],
        ['Rows created by the run removed', report.cleanup.ok ? 'yes' : 'NO'],
        [
          'Seeded demo rows unchanged',
          report.cleanup.seededRowsUnchanged === null
            ? 'not checked'
            : report.cleanup.seededRowsUnchanged
              ? 'yes'
              : 'NO',
        ],
        [
          'Rows removed',
          Object.entries(report.cleanup.removed)
            .map(([name, count]) => `${name} ${count}`)
            .join(', ') || 'none',
        ],
      ],
    ),
    '',
  ];
  for (const problem of report.cleanup.problems) lines.push(`- ${problem}`);
  if (report.cleanup.problems.length > 0) lines.push('');
  return lines.join('\n');
}
