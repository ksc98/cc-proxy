import { useEffect, useMemo, useState } from "react";
import { MessageSquare, ArrowUpFromLine, Database, DollarSign } from "lucide-react";
import type { Stats, TransactionRow } from "@/lib/store";
import { fmtInt, fmtDuration } from "@/lib/format";
import {
  sparkTurnsPerMinute,
  sparkOutputTokens,
  sparkCacheHitPct,
  sparkCostUsd,
} from "@/lib/sparklines";
import { subscribeStats, seedStats } from "@/lib/statsBus";
import { subscribeRows, seedRows } from "@/lib/rowsBus";
import KpiValue, { type KpiValueKind } from "./KpiValue";
import Sparkline from "./Sparkline";

type Accent = "volume" | "money" | "neutral";
type SparkMode = "line" | "bars";

interface CardProps {
  label: string;
  valueNum: number;
  valueKind: KpiValueKind;
  sub: string;
  accent: Accent;
  sparkValues: number[];
  sparkMode: SparkMode;
  icon: React.ReactNode;
}

function KpiCard({
  label,
  valueNum,
  valueKind,
  sub,
  accent,
  sparkValues,
  sparkMode,
  icon,
}: CardProps) {
  const sparkColor =
    accent === "money"
      ? "var(--color-money)"
      : accent === "volume"
        ? "var(--color-volume)"
        : "var(--color-muted-foreground)";

  const valueClass =
    accent === "money"
      ? "text-[var(--color-money)]"
      : "text-[var(--color-foreground)]";

  const iconClass =
    accent === "money"
      ? "text-[var(--color-money)]"
      : accent === "volume"
        ? "text-[var(--color-volume)]"
        : "text-[var(--color-muted-foreground)]";

  const hasSpark = sparkValues.length > 1;

  return (
    <div className="card card-hover p-5 overflow-hidden relative block kpi-card">
      {hasSpark && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 opacity-25"
          style={{ height: "68%" }}
        >
          <Sparkline
            values={sparkValues}
            mode={sparkMode}
            color={sparkColor}
            width={320}
            height={96}
            fillOpacity={0.22}
            strokeWidth={1.25}
          />
        </div>
      )}
      <div className="relative flex items-start justify-between mb-4">
        <p className="text-[0.6875rem] uppercase tracking-[0.08em] text-[var(--color-muted-foreground)] font-medium">
          {label}
        </p>
        <div className={iconClass}>{icon}</div>
      </div>
      <div className="relative">
        <p
          className={`font-mono text-3xl font-semibold tracking-tight tabular-nums ${valueClass}`}
        >
          <KpiValue num={valueNum} kind={valueKind} />
        </p>
        {sub && (
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <p className="text-xs text-[var(--color-subtle-foreground)] tabular-nums">
              {sub}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// Trailing-20 per-minute turn rate. Kept identical to the SSR computation
// in index.astro so the first paint matches on hydration.
const sparkTurnsFrom = sparkTurnsPerMinute;
const sparkOutputFrom = sparkOutputTokens;
const sparkCacheFrom = sparkCacheHitPct;
const sparkCostFrom = sparkCostUsd;

export default function LiveKpiGrid({
  initialStats,
  initialRows,
}: {
  initialStats: Stats;
  initialRows: TransactionRow[];
}) {
  const [stats, setStats] = useState<Stats>(initialStats);
  const [rows, setRows] = useState<TransactionRow[]>(initialRows);

  useEffect(() => {
    seedStats(initialStats);
    return subscribeStats(setStats);
  }, [initialStats]);

  useEffect(() => {
    // rowsBus publishes the current windowed /api/recent snapshot. We take
    // it verbatim — the window stays whatever WsClient is refetching. Seed
    // the bus with our SSR baseline so WsClient's turn_complete handler
    // merges against a real set instead of starting from [].
    seedRows(initialRows);
    return subscribeRows(setRows);
  }, [initialRows]);

  const { sparkTurns, sparkOutput, sparkCache, sparkCost } = useMemo(
    () => ({
      sparkTurns: sparkTurnsFrom(rows),
      sparkOutput: sparkOutputFrom(rows),
      sparkCache: sparkCacheFrom(rows),
      sparkCost: sparkCostFrom(rows),
    }),
    [rows],
  );

  const avgLatency = stats.turns > 0 ? stats.total_elapsed_ms / stats.turns : 0;
  const cacheDenom = stats.input_tokens + stats.cache_read + stats.cache_creation;
  const cacheRate = cacheDenom > 0 ? stats.cache_read / cacheDenom : 0;
  const cacheRatePct = Math.round(cacheRate * 100);
  const ttlKnown = stats.cache_creation_5m + stats.cache_creation_1h > 0;
  const longTtlPct = ttlKnown
    ? (stats.cache_creation_1h / (stats.cache_creation_5m + stats.cache_creation_1h)) * 100
    : 0;

  return (
    <section
      className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8"
      data-live-region="kpis"
    >
      <KpiCard
        label="Turns"
        valueNum={stats.turns}
        valueKind="int"
        sub={`${fmtDuration(avgLatency)} avg`}
        accent="neutral"
        sparkValues={sparkTurns}
        sparkMode="line"
        icon={<MessageSquare size={16} />}
      />
      <KpiCard
        label="Output tokens"
        valueNum={stats.output_tokens}
        valueKind="int"
        sub={`${fmtInt(stats.input_tokens)} input`}
        accent="volume"
        sparkValues={sparkOutput}
        sparkMode="bars"
        icon={<ArrowUpFromLine size={16} />}
      />
      <KpiCard
        label="Cache hit"
        valueNum={cacheRatePct}
        valueKind="pct"
        sub={
          ttlKnown
            ? `${fmtInt(stats.cache_read)} read · ${longTtlPct.toFixed(0)}% 1h TTL`
            : `${fmtInt(stats.cache_read)} read`
        }
        accent="volume"
        sparkValues={sparkCache}
        sparkMode="line"
        icon={<Database size={16} />}
      />
      <KpiCard
        label="Cost"
        valueNum={stats.estimated_cost_usd}
        valueKind="usd"
        sub={`${fmtInt(stats.turns)} turns · ${stats.sessions} sessions`}
        accent="money"
        sparkValues={sparkCost}
        sparkMode="bars"
        icon={<DollarSign size={16} />}
      />
    </section>
  );
}
