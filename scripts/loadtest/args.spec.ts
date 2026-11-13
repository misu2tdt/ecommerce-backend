import {
  DEFAULT_OPTIONS,
  DEFAULT_OUTPUT,
  parseArgs,
  parseScenarioList,
  UsageError,
} from './args';

function run(...argv: string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'run') throw new Error('expected a run');
  return parsed.options;
}

describe('load test arguments', () => {
  it('uses the documented defaults', () => {
    expect(run()).toEqual({
      customers: 200,
      stock: 10,
      parallel: 20,
      orders: 5,
      scenarios: [1, 2, 3, 4, 5],
      output: DEFAULT_OUTPUT,
      cleanupLeftovers: false,
    });
    expect(DEFAULT_OPTIONS.scenarios).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not share the default scenario list between parses', () => {
    run().scenarios.pop();
    expect(run().scenarios).toHaveLength(5);
  });

  it('reads values after the flag or after an equals sign', () => {
    expect(
      run('--customers', '50', '--stock=5', '--parallel', '8'),
    ).toMatchObject({ customers: 50, stock: 5, parallel: 8 });
    expect(run('--orders=3')).toMatchObject({ orders: 3 });
  });

  it('shows help for --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('handles the on/off flags', () => {
    expect(run('--no-write').output).toBeNull();
    expect(run('--output', 'out/results.md').output).toBe('out/results.md');
    expect(run('--cleanup-leftovers').cleanupLeftovers).toBe(true);
  });

  it('parses scenario lists, sorted and without repeats', () => {
    expect(parseScenarioList('all')).toEqual([1, 2, 3, 4, 5]);
    expect(parseScenarioList('5, 1,3,3')).toEqual([1, 3, 5]);
    expect(run('--scenarios', '2').scenarios).toEqual([2]);
  });

  it.each([
    [['--customers', 'ten'], /whole number/],
    [['--customers', '1'], /between 2 and 2000/],
    [['--customers', '5000'], /between 2 and 2000/],
    [['--parallel', '1'], /between 2 and 100/],
    [['--orders', '0'], /between 1 and 50/],
    [['--scenarios', '6'], /1 to 5/],
    [['--scenarios', '1,x'], /1 to 5/],
    [['--customers'], /needs a value/],
    [['--customers', '--stock', '3'], /needs a value/],
    [['--bogus'], /Unknown option/],
    [['stray'], /Unexpected argument/],
    [['--no-write=yes'], /does not take a value/],
    [['--output', ' '], /file path/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it('needs more customers than stock, or nobody would be refused', () => {
    expect(() => parseArgs(['--customers', '10', '--stock', '10'])).toThrow(
      /below --customers/,
    );
    expect(() => parseArgs(['--stock', '200'])).toThrow(/below --customers/);
    expect(run('--customers', '11', '--stock', '10').stock).toBe(10);
  });
});
