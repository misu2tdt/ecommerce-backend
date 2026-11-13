// Command-line options of the concurrency check. Pure: no I/O, so it is unit tested.

export type ScenarioId = 1 | 2 | 3 | 4 | 5;
export const ALL_SCENARIOS: readonly ScenarioId[] = [1, 2, 3, 4, 5];

export const DEFAULT_OUTPUT = 'docs/load-test-results.md';

export interface LoadTestOptions {
  /** Customers racing in the oversell and deadlock scenarios. */
  customers: number;
  /** Units in stock for the oversell and deadlock scenarios. */
  stock: number;
  /** Parallel requests per order in the payment scenarios. */
  parallel: number;
  /** Orders per payment scenario. */
  orders: number;
  scenarios: ScenarioId[];
  /** Where to write the Markdown results, or null to only print them. */
  output: string | null;
  /** Remove rows left behind by an earlier, interrupted run, then stop. */
  cleanupLeftovers: boolean;
}

export const DEFAULT_OPTIONS: LoadTestOptions = {
  customers: 200,
  stock: 10,
  parallel: 20,
  orders: 5,
  scenarios: [...ALL_SCENARIOS],
  output: DEFAULT_OUTPUT,
  cleanupLeftovers: false,
};

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'run'; options: LoadTestOptions };

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `Concurrency check for orders and payments (local, isolated test database only).

Usage: npm run loadtest:concurrency -- [options]

Options:
  --customers <n>       Customers in the oversell and deadlock scenarios (default ${DEFAULT_OPTIONS.customers}, 2-2000)
  --stock <k>           Stock of the contested variant(s) (default ${DEFAULT_OPTIONS.stock}, must be below --customers)
  --parallel <m>        Parallel requests per order in the payment scenarios (default ${DEFAULT_OPTIONS.parallel}, 2-100)
  --orders <r>          Orders per payment scenario (default ${DEFAULT_OPTIONS.orders}, 1-50)
  --scenarios <list>    Comma separated scenario numbers 1-5, or "all" (default all)
  --output <file>       Markdown results file (default ${DEFAULT_OUTPUT})
  --no-write            Print the results only; do not write a file
  --cleanup-leftovers   Delete rows of an earlier interrupted run, then exit
  --help                Show this text

Required environment (the run is refused without it):
  NODE_ENV=test  DB_NAME=ecommerce_test  DB_PORT=<test database port>
  ECOMMERCE_TEST_DB_PASSWORD=<test database password>
  DB_HOST (default localhost) and DB_USERNAME (default postgres) are optional.
`;

const VALUE_FLAGS = new Set([
  'customers',
  'stock',
  'parallel',
  'orders',
  'scenarios',
  'output',
]);
const BOOLEAN_FLAGS = new Set(['help', 'no-write', 'cleanup-leftovers']);

function readInteger(flag: string, raw: string, min: number, max: number) {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--${flag} must be a whole number, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new UsageError(`--${flag} must be between ${min} and ${max}`);
  }
  return value;
}

export function parseScenarioList(raw: string): ScenarioId[] {
  if (raw.trim().toLowerCase() === 'all') return [...ALL_SCENARIOS];
  const picked = new Set<ScenarioId>();
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (!/^[1-5]$/.test(text)) {
      throw new UsageError(
        `--scenarios must list numbers from 1 to 5 or "all", got "${raw}"`,
      );
    }
    picked.add(Number(text) as ScenarioId);
  }
  return [...picked].sort((a, b) => a - b);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options: LoadTestOptions = {
    ...DEFAULT_OPTIONS,
    scenarios: [...DEFAULT_OPTIONS.scenarios],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-h') return { kind: 'help' };
    if (!token.startsWith('--')) {
      throw new UsageError(`Unexpected argument "${token}"`);
    }

    const equals = token.indexOf('=');
    const flag = token.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inline !== undefined) {
        throw new UsageError(`--${flag} does not take a value`);
      }
      if (flag === 'help') return { kind: 'help' };
      if (flag === 'no-write') options.output = null;
      if (flag === 'cleanup-leftovers') options.cleanupLeftovers = true;
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(`Unknown option --${flag}`);
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`--${flag} needs a value`);
      }
      value = next;
      index += 1;
    }

    switch (flag) {
      case 'customers':
        options.customers = readInteger(flag, value, 2, 2000);
        break;
      case 'stock':
        options.stock = readInteger(flag, value, 1, 1000);
        break;
      case 'parallel':
        options.parallel = readInteger(flag, value, 2, 100);
        break;
      case 'orders':
        options.orders = readInteger(flag, value, 1, 50);
        break;
      case 'scenarios':
        options.scenarios = parseScenarioList(value);
        break;
      case 'output':
        if (value.trim().length === 0) {
          throw new UsageError('--output needs a file path');
        }
        options.output = value;
        break;
    }
  }

  if (options.stock >= options.customers) {
    throw new UsageError(
      '--stock must be below --customers, or nobody is refused and the oversell check proves nothing',
    );
  }
  return { kind: 'run', options };
}
