import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TransactionRow } from "@/lib/store";
import { estimateCostUsd } from "@/lib/format";
import { subscribeRows } from "@/lib/rowsBus";

type Point = {
  ts: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  cost: number;
};

function rowsToPoints(rows: TransactionRow[]): Point[] {
  return [...rows]
    .sort((a, b) => a.ts - b.ts)
    .filter((r) => r.output_tokens > 0 || r.input_tokens > 50)
    .slice(-30)
    .map((r) => ({
      ts: r.ts,
      input: Math.max(r.input_tokens, 1),
      output: Math.max(r.output_tokens, 1),
      cache_read: Math.max(r.cache_read, 1),
      cache_creation: Math.max(r.cache_creation, 1),
      cost: estimateCostUsd(r),
    }));
}

function fmtTs(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export default function TokenChart({
  initialRows,
}: {
  initialRows: TransactionRow[];
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(0);
  const [rows, setRows] = useState<TransactionRow[]>(initialRows);
  const baselineRef = useRef(initialRows);
  const height = 280;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    const initial = el.getBoundingClientRect().width;
    if (initial > 0) setWidth(Math.floor(initial));
    return () => ro.disconnect();
  }, []);

  // Merge WS-pushed rows into the SSR baseline so the chart keeps showing
  // the full pill-windowed dataset instead of only live rows.
  useEffect(
    () =>
      subscribeRows((busRows) => {
        const byId = new Map<string, TransactionRow>();
        for (const r of baselineRef.current) byId.set(r.tx_id, r);
        for (const r of busRows) byId.set(r.tx_id, r);
        setRows([...byId.values()]);
      }),
    [],
  );

  const data = useMemo(() => rowsToPoints(rows), [rows]);

  if (data.length === 0) return null;
  return (
    <div ref={wrapRef} style={{ width: "100%", height }}>
      {width > 0 && (
        <ComposedChart
          width={width}
          height={height}
          data={data}
          margin={{ top: 12, right: 48, bottom: 4, left: 4 }}
        >
          <defs>
            <linearGradient id="fillCacheRead" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="fillCacheCreation" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="fillOutput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-4)" stopOpacity={0.45} />
              <stop offset="95%" stopColor="var(--color-chart-4)" stopOpacity={0.08} />
            </linearGradient>
            <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-chart-5)" stopOpacity={0.5} />
              <stop offset="95%" stopColor="var(--color-chart-5)" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--color-border)"
            strokeDasharray="2 4"
            vertical={false}
          />
          <XAxis
            dataKey="ts"
            tickFormatter={fmtTs}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            minTickGap={60}
            interval="preserveStartEnd"
          />
          <YAxis
            yAxisId="tokens"
            scale="log"
            domain={[1, "dataMax"]}
            tickFormatter={fmtTokens}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            width={40}
            allowDataOverflow={false}
          />
          <YAxis
            yAxisId="cost"
            orientation="right"
            tickFormatter={fmtUsd}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-money)", fontSize: 11 }}
            width={44}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-card-elevated)",
              border: "1px solid var(--color-border-strong)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(v) => fmtTs(v as number)}
            formatter={(value, name) => {
              if (name === "cost") return [fmtUsd(value as number), "cost"];
              return [fmtTokens(value as number), name];
            }}
          />
          {/* Independent (not stacked) overlapping areas — stacking on log
              scale is mathematically invalid, so each series gets its own
              alpha-fill layer. Order matters for visual stacking: largest
              series first so smaller ones remain visible on top. */}
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="cache_read"
            stroke="var(--color-chart-1)"
            strokeWidth={1.25}
            fill="url(#fillCacheRead)"
            name="cache_read"
            isAnimationActive={false}
          />
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="cache_creation"
            stroke="var(--color-chart-2)"
            strokeWidth={1.25}
            fill="url(#fillCacheCreation)"
            name="cache_creation"
            isAnimationActive={false}
          />
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="output"
            stroke="var(--color-chart-4)"
            strokeWidth={1.25}
            fill="url(#fillOutput)"
            name="output"
            isAnimationActive={false}
          />
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="input"
            stroke="var(--color-chart-5)"
            strokeWidth={1.25}
            fill="url(#fillInput)"
            name="input"
            isAnimationActive={false}
          />
          <Line
            yAxisId="cost"
            type="monotone"
            dataKey="cost"
            stroke="var(--color-money)"
            strokeWidth={1.75}
            dot={false}
            name="cost"
            isAnimationActive={false}
          />
        </ComposedChart>
      )}
    </div>
  );
}
