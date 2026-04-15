import type { SessionEnds, TransactionRow } from "@/lib/store";
import { estimateCostUsd } from "@/lib/format";

// A session is "active" if its most recent turn lands within this window
// AND no SessionEnd marker has been recorded at-or-after that last turn.
export const ACTIVE_WINDOW_MS = 3 * 60_000;

export type SessionSummary = {
  id: string;
  turns: number;
  costUsd: number;
  firstTs: number;
  lastTs: number;
  active: boolean;
  topModel: string | null;
  modelCount: number;
};

export function buildSessionList(
  rows: TransactionRow[],
  sessionEnds: SessionEnds,
): SessionSummary[] {
  type Agg = {
    id: string;
    turns: number;
    firstTs: number;
    lastTs: number;
    cost: number;
    models: Map<string, number>;
  };
  const map = new Map<string, Agg>();
  for (const r of rows) {
    if (!r.session_id) continue;
    const cur =
      map.get(r.session_id) ??
      ({
        id: r.session_id,
        turns: 0,
        firstTs: r.ts,
        lastTs: r.ts,
        cost: 0,
        models: new Map(),
      } satisfies Agg);
    cur.turns += 1;
    cur.firstTs = Math.min(cur.firstTs, r.ts);
    cur.lastTs = Math.max(cur.lastTs, r.ts);
    cur.cost += estimateCostUsd(r);
    if (r.model) {
      cur.models.set(r.model, (cur.models.get(r.model) ?? 0) + 1);
    }
    map.set(r.session_id, cur);
  }

  const now = Date.now();
  const isActive = (s: Agg): boolean => {
    if (now - s.lastTs >= ACTIVE_WINDOW_MS) return false;
    const endedAt = sessionEnds[s.id];
    return endedAt == null || endedAt < s.lastTs;
  };

  const shortModel = (m: string): string =>
    m.replace(/-\d{8}$/, "").replace(/^claude-/, "");

  return [...map.values()]
    .map((agg) => {
      const top = [...agg.models.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        id: agg.id,
        turns: agg.turns,
        costUsd: agg.cost,
        firstTs: agg.firstTs,
        lastTs: agg.lastTs,
        active: isActive(agg),
        topModel: top ? shortModel(top[0]) : null,
        modelCount: agg.models.size,
      } satisfies SessionSummary;
    })
    .sort((a, b) => {
      const aa = a.active ? 1 : 0;
      const ba = b.active ? 1 : 0;
      if (aa !== ba) return ba - aa;
      return b.lastTs - a.lastTs;
    });
}
