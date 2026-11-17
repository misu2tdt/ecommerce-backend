// Reads the JSON that EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) returns. Pure and
// unit tested: the run script only fetches the plans and prints what is read
// here.

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}

export interface ExplainDocument {
  Plan: PlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

export interface PlanSummary {
  // Every node type in the plan, in tree order, for example
  // ["Limit", "Sort", "Bitmap Heap Scan", "Bitmap Index Scan"].
  nodes: string[];
  indexes: string[];
  // How "products" is read: "Seq Scan", "Bitmap Heap Scan" (through an index) ...
  productsScan: string | null;
  executionMs: number;
  planningMs: number;
  sharedHit: number;
  sharedRead: number;
}

// EXPLAIN FORMAT JSON gives an array with one document.
export function readExplain(raw: unknown): ExplainDocument {
  const document: unknown = Array.isArray(raw) ? (raw[0] as unknown) : raw;
  if (
    typeof document !== 'object' ||
    document === null ||
    !('Plan' in document)
  ) {
    throw new Error('Not an EXPLAIN (FORMAT JSON) result');
  }
  return document as ExplainDocument;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

export function summarisePlan(raw: unknown): PlanSummary {
  const document = readExplain(raw);
  const nodes: string[] = [];
  const indexes = new Set<string>();
  let productsScan: string | null = null;
  walk(document.Plan, (node) => {
    nodes.push(node['Node Type']);
    if (node['Index Name']) indexes.add(node['Index Name']);
    if (
      node['Relation Name'] === 'products' &&
      /Scan$/.test(node['Node Type']) &&
      productsScan === null
    ) {
      productsScan = node['Node Type'];
    }
  });
  return {
    nodes,
    indexes: [...indexes],
    productsScan,
    executionMs: document['Execution Time'] ?? 0,
    planningMs: document['Planning Time'] ?? 0,
    sharedHit: document.Plan['Shared Hit Blocks'] ?? 0,
    sharedRead: document.Plan['Shared Read Blocks'] ?? 0,
  };
}

export function usesIndex(summary: PlanSummary, indexName: string): boolean {
  return summary.indexes.includes(indexName);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median of nothing');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// "0.42 ms", "12.3 ms", "1,234 ms": enough digits to compare, no more.
export function formatMs(value: number): string {
  if (value < 10) return `${value.toFixed(2)} ms`;
  if (value < 100) return `${value.toFixed(1)} ms`;
  return `${Math.round(value).toLocaleString('en-US')} ms`;
}

// One short line about how the table is read: "Bitmap Heap Scan (IDX_...)".
export function describeScan(summary: PlanSummary): string {
  const scan = summary.productsScan ?? 'no scan of products';
  return summary.indexes.length > 0
    ? `${scan} using ${summary.indexes.join(', ')}`
    : scan;
}
