import {
  describeScan,
  formatMs,
  median,
  readExplain,
  summarisePlan,
  usesIndex,
} from './plan-summary';

const seqScan = [
  {
    Plan: {
      'Node Type': 'Limit',
      'Shared Hit Blocks': 40,
      'Shared Read Blocks': 2,
      Plans: [
        {
          'Node Type': 'Sort',
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Relation Name': 'products',
            },
          ],
        },
      ],
    },
    'Planning Time': 0.21,
    'Execution Time': 18.4,
  },
];

const indexScan = [
  {
    Plan: {
      'Node Type': 'Limit',
      'Shared Hit Blocks': 9,
      Plans: [
        {
          'Node Type': 'Sort',
          Plans: [
            {
              'Node Type': 'Bitmap Heap Scan',
              'Relation Name': 'products',
              Plans: [
                {
                  'Node Type': 'Bitmap Index Scan',
                  'Index Name': 'IDX_products_name_trgm',
                },
              ],
            },
          ],
        },
      ],
    },
    'Planning Time': 0.3,
    'Execution Time': 0.8,
  },
];

describe('EXPLAIN plan summary', () => {
  it('reads a plan that scans the whole table', () => {
    const summary = summarisePlan(seqScan);

    expect(summary).toEqual({
      nodes: ['Limit', 'Sort', 'Seq Scan'],
      indexes: [],
      productsScan: 'Seq Scan',
      executionMs: 18.4,
      planningMs: 0.21,
      sharedHit: 40,
      sharedRead: 2,
    });
    expect(usesIndex(summary, 'IDX_products_name_trgm')).toBe(false);
    expect(describeScan(summary)).toBe('Seq Scan');
  });

  it('reads a plan that goes through the trigram index', () => {
    const summary = summarisePlan(indexScan);

    expect(summary.nodes).toEqual([
      'Limit',
      'Sort',
      'Bitmap Heap Scan',
      'Bitmap Index Scan',
    ]);
    expect(summary.indexes).toEqual(['IDX_products_name_trgm']);
    expect(summary.productsScan).toBe('Bitmap Heap Scan');
    expect(usesIndex(summary, 'IDX_products_name_trgm')).toBe(true);
    expect(usesIndex(summary, 'something_else')).toBe(false);
    expect(describeScan(summary)).toBe(
      'Bitmap Heap Scan using IDX_products_name_trgm',
    );
  });

  it('accepts the document with or without the surrounding array', () => {
    expect(readExplain(seqScan)).toBe(seqScan[0]);
    expect(readExplain(seqScan[0])).toBe(seqScan[0]);
  });

  it('refuses something that is not an EXPLAIN result', () => {
    expect(() => readExplain([])).toThrow('EXPLAIN');
    expect(() => readExplain({ nope: 1 })).toThrow('EXPLAIN');
    expect(() => readExplain(null)).toThrow('EXPLAIN');
  });

  it('says so when the products table is not read at all', () => {
    expect(
      describeScan(summarisePlan([{ Plan: { 'Node Type': 'Result' } }])),
    ).toBe('no scan of products');
  });

  it('takes the median of an odd and an even number of runs', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(() => median([])).toThrow();
  });

  it('formats milliseconds with enough digits to compare', () => {
    expect(formatMs(0.4234)).toBe('0.42 ms');
    expect(formatMs(12.34)).toBe('12.3 ms');
    expect(formatMs(1234.5)).toBe('1,235 ms');
  });
});
