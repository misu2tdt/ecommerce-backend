// The scratch rows the search measurement runs against. They are real rows in
// "products", all with a slug that starts with SCRATCH_SLUG_PREFIX and one
// scratch category, and the run removes exactly those rows when it ends. Names
// are built from short word lists, so the same count always gives the same
// names, and the share of rows a search term matches is known.

export const SCRATCH_SLUG_PREFIX = 'search-explain-';
export const SCRATCH_CATEGORY_SLUG = 'search-explain-category';

const ADJECTIVES = [
  'Classic',
  'Relaxed',
  'Heavyweight',
  'Lightweight',
  'Tailored',
  'Garment-Dyed',
  'Everyday',
  'Essential',
  'Structured',
  'Seamless',
  'Packable',
  'Washed',
] as const;
const FABRICS = [
  'Cotton',
  'Linen',
  'Wool',
  'Merino',
  'Denim',
  'Fleece',
  'Ripstop',
  'Modal',
  'Canvas',
  'Poplin',
] as const;
const GARMENTS = [
  'Tee',
  'Shirt',
  'Polo',
  'Hoodie',
  'Jacket',
  'Trousers',
  'Shorts',
  'Joggers',
  'Cap',
  'Tote',
  'Socks',
  'Robe',
  'Leggings',
  'Overshirt',
] as const;
// Added to one row in a thousand: a rare word.
export const RARE_WORD = 'Zephyr';
export const RARE_EVERY = 1000;

export interface SearchTerm {
  label: string;
  term: string;
  // What the term is meant to show.
  note: string;
}

// Chosen from the word lists above, so their share of the rows is known.
export const SEARCH_TERMS: readonly SearchTerm[] = [
  { label: 'rare word', term: 'zephyr', note: 'about 0.1% of the rows' },
  { label: 'common fabric', term: 'linen', note: 'about 10% of the rows' },
  { label: 'common garment', term: 'tee', note: 'about 7% of the rows' },
  {
    label: 'two letters',
    term: 'er',
    note: 'about a quarter of the rows; too short for a trigram index (it needs 3 letters)',
  },
];

// The name of row number `n` (1-based).
export function scratchName(n: number): string {
  const adjective = ADJECTIVES[(n * 7) % ADJECTIVES.length];
  const fabric = FABRICS[(n * 3) % FABRICS.length];
  const garment = GARMENTS[(n * 11) % GARMENTS.length];
  const rare = n % RARE_EVERY === 0 ? ` ${RARE_WORD}` : '';
  return `${adjective} ${fabric} ${garment}${rare}`;
}

export function scratchSlug(n: number): string {
  return `${SCRATCH_SLUG_PREFIX}${n}`;
}

// One INSERT ... SELECT that creates rows 1..count (status active, in the
// scratch category). The names are built in SQL from the same word lists and the
// same arithmetic as scratchName, so the two can not drift apart (a test
// compares them).
export function scratchInsertSql(): string {
  const list = (values: readonly string[]) =>
    `ARRAY[${values.map((value) => `'${value}'`).join(',')}]`;
  return `
    INSERT INTO "products" ("name", "slug", "status", "categoryId")
    SELECT
      (${list(ADJECTIVES)})[((g * 7) % ${ADJECTIVES.length}) + 1] || ' ' ||
      (${list(FABRICS)})[((g * 3) % ${FABRICS.length}) + 1] || ' ' ||
      (${list(GARMENTS)})[((g * 11) % ${GARMENTS.length}) + 1] ||
      CASE WHEN g % ${RARE_EVERY} = 0 THEN ' ${RARE_WORD}' ELSE '' END,
      '${SCRATCH_SLUG_PREFIX}' || g,
      'active',
      $1
    FROM generate_series(1, $2) AS g`;
}

export const SCRATCH_DELETE_SQL = `DELETE FROM "products" WHERE "slug" LIKE '${SCRATCH_SLUG_PREFIX}%'`;
