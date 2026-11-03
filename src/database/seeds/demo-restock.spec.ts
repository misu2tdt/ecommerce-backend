import {
  formatRestockSummary,
  parseRestockArguments,
  resolveRestockTarget,
  type RestockSummary,
} from './demo-restock';

describe('parseRestockArguments', () => {
  it('runs for real by default', () => {
    expect(parseRestockArguments([])).toEqual({ dryRun: false });
  });

  it('understands --dry-run', () => {
    expect(parseRestockArguments(['--dry-run'])).toEqual({ dryRun: true });
  });

  it.each([['--force'], ['dry-run'], ['--dry-run=false'], ['--dry-run', '-y']])(
    'refuses anything else (%s) instead of ignoring it',
    (...args) => {
      expect(() => parseRestockArguments(args)).toThrow(/Unknown argument/);
    },
  );
});

describe('resolveRestockTarget', () => {
  it.each([
    ['production', 'production'],
    ['test', 'test'],
    ['development', 'development'],
    [undefined, 'development'],
  ])('maps NODE_ENV=%s to the %s target', (nodeEnv, target) => {
    expect(resolveRestockTarget(nodeEnv)).toBe(target);
  });

  it('refuses a NODE_ENV it does not know', () => {
    expect(() => resolveRestockTarget('staging')).toThrow(/NODE_ENV/);
  });
});

describe('formatRestockSummary', () => {
  const summary: RestockSummary = {
    dryRun: false,
    seededVariants: 72,
    changed: 2,
    stockBefore: 1000,
    stockAfter: 1060,
    reservedByPendingOrders: 3,
    changes: [
      { sku: 'AT-CCT-BLK-M', before: 0, after: 24, reserved: 1 },
      { sku: 'KB-CDJ-GRY-M', before: 4, after: 40, reserved: 0 },
    ],
  };

  it('prints the before and after totals and each change', () => {
    const lines = formatRestockSummary(summary);

    expect(lines).toContain('Total stock before: 1000');
    expect(lines).toContain('Total stock after: 1060');
    expect(lines).toContain('Variants raised: 2 of 72');
    expect(lines.some((line) => /AT-CCT-BLK-M.*0.*24/.test(line))).toBe(true);
  });

  it('says plainly when it only simulated', () => {
    const lines = formatRestockSummary({ ...summary, dryRun: true });

    expect(lines[0]).toMatch(/dry run/i);
    expect(lines.join('\n')).toMatch(/nothing was changed/i);
  });
});
