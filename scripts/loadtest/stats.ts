// Small statistics helpers. Pure.

/** Nearest-rank percentile of already collected values. Returns null if empty. */
export function percentile(
  values: readonly number[],
  percent: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function formatMs(value: number | null): string {
  if (value === null) return 'n/a';
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${value.toFixed(1)} ms`;
}

export function formatRate(requests: number, wallMs: number): string {
  if (wallMs <= 0) return 'n/a';
  return `${((requests * 1000) / wallMs).toFixed(1)}/s`;
}
