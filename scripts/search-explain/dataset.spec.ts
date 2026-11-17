import {
  RARE_EVERY,
  RARE_WORD,
  SCRATCH_SLUG_PREFIX,
  SEARCH_TERMS,
  scratchInsertSql,
  scratchName,
  scratchSlug,
} from './dataset';

describe('search measurement scratch data', () => {
  it('builds the same name for the same number', () => {
    expect(scratchName(1)).toBe(scratchName(1));
    expect(scratchName(1)).toMatch(/^\S+ \S+ \S+$/);
  });

  it('gives the rare word to one row in a thousand and no other', () => {
    const names = Array.from({ length: 5000 }, (_, index) =>
      scratchName(index + 1),
    );
    const rare = names.filter((name) => name.includes(RARE_WORD));

    expect(rare).toHaveLength(5000 / RARE_EVERY);
    expect(names.filter((name) => /zephyr/i.test(name))).toHaveLength(5);
  });

  it('matches the share of rows each search term is meant to show', () => {
    const names = Array.from({ length: 10_000 }, (_, index) =>
      scratchName(index + 1),
    );
    const share = (term: string) =>
      names.filter((name) => name.toLowerCase().includes(term)).length /
      names.length;

    expect(share('zephyr')).toBeLessThan(0.002);
    expect(share('linen')).toBeGreaterThan(0.08);
    expect(share('linen')).toBeLessThan(0.12);
    expect(share('tee')).toBeGreaterThan(0.05);
    expect(share('tee')).toBeLessThan(0.1);
    expect(share('er')).toBeGreaterThan(0.15);
    expect(SEARCH_TERMS.map((entry) => entry.term)).toEqual([
      'zephyr',
      'linen',
      'tee',
      'er',
    ]);
  });

  it('marks every row with the scratch slug prefix', () => {
    expect(scratchSlug(42)).toBe(`${SCRATCH_SLUG_PREFIX}42`);
    expect(scratchSlug(42).startsWith('search-explain-')).toBe(true);
  });

  it('builds the rows in SQL from the same lists as scratchName', () => {
    const sql = scratchInsertSql();

    for (const word of ['Classic', 'Linen', 'Hoodie']) {
      expect(sql).toContain(`'${word}'`);
    }
    expect(sql).toContain(`' ${RARE_WORD}'`);
    expect(sql).toContain('generate_series(1, $2)');
    expect(sql).toContain(`g % ${RARE_EVERY} = 0`);
    expect(sql).toContain(`'${SCRATCH_SLUG_PREFIX}' || g`);
    expect(sql).toContain("'active'");
  });
});
