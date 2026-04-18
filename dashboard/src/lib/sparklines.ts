// Derived sparkline series for KPI cards on the overview page. Pulled out
// of index.astro + LiveKpiGrid so the SSR baseline and the live re-renders
// can't drift. All functions take chronological rows (will sort defensively)
// and return plain number[] ready to hand to <Sparkline />.

import type { TransactionRow } from "@/lib/store";
import { estimateCostUsd } from "@/lib/format";

function sortedByTs(rows: TransactionRow[]): TransactionRow[] {
  return [...rows].sort((a, b) => a.ts - b.ts);
}

/** Trailing-20 per-minute turn rate. When there are fewer than 2 rows we
 * fall back to a strictly-monotonic 1..n ramp so the sparkline has
 * something to draw on cold pages. */
export function sparkTurnsPerMinute(rows: TransactionRow[], keep = 20): number[] {
  const chron = sortedByTs(rows);
  if (chron.length < 2) return chron.map((_, i) => i + 1);
  const buckets = new Map<number, number>();
  for (const r of chron) {
    const m = Math.floor(r.ts / 60_000);
    buckets.set(m, (buckets.get(m) ?? 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.slice(-keep).map(([, n]) => n);
}

/** Output tokens per turn for the trailing `keep` turns. */
export function sparkOutputTokens(rows: TransactionRow[], keep = 30): number[] {
  return sortedByTs(rows).map((r) => r.output_tokens).slice(-keep);
}

/** Rolling-window cache-read hit ratio (as a 0–100 percent), one sample
 * per turn, trailing `keep` samples. */
export function sparkCacheHitPct(
  rows: TransactionRow[],
  window = 5,
  keep = 30,
): number[] {
  const chron = sortedByTs(rows);
  const arr: number[] = [];
  const win: TransactionRow[] = [];
  for (const r of chron) {
    win.push(r);
    if (win.length > window) win.shift();
    const denom = win.reduce(
      (a, x) => a + x.input_tokens + x.cache_read + x.cache_creation,
      0,
    );
    const num = win.reduce((a, x) => a + x.cache_read, 0);
    arr.push(denom > 0 ? (num / denom) * 100 : 0);
  }
  return arr.slice(-keep);
}

/** Estimated $ cost per turn for the trailing `keep` turns. */
export function sparkCostUsd(rows: TransactionRow[], keep = 30): number[] {
  return sortedByTs(rows).map((r) => estimateCostUsd(r)).slice(-keep);
}
