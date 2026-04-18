import { lazy, Suspense } from "react";
import { useHydrated } from "@/hooks/use-hydrated";

export type KpiValueKind = "int" | "usd" | "pct";

interface Props {
  num: number;
  kind: KpiValueKind;
  className?: string;
}

function usdDigits(n: number): number {
  return Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2;
}

function formatPlain(num: number, kind: KpiValueKind): string {
  if (kind === "usd") {
    const d = usdDigits(num);
    return num.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    });
  }
  if (kind === "pct") return `${Math.round(num)}%`;
  return num.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// NumberFlow registers web-component globals on module evaluation and
// references DOM APIs that aren't available in Cloudflare Workers' SSR
// runtime. React.lazy + top-level dynamic import keep the module out of
// the server bundle entirely — it's only fetched once the client decides
// to render NumberFlow (post-hydration).
const NumberFlowLazy = lazy(() => import("@number-flow/react"));

function Animated({ num, kind, className }: Props) {
  if (kind === "usd") {
    const d = usdDigits(num);
    return (
      <NumberFlowLazy
        className={className}
        value={num}
        format={{
          style: "currency",
          currency: "USD",
          minimumFractionDigits: d,
          maximumFractionDigits: d,
        }}
      />
    );
  }
  if (kind === "pct") {
    return (
      <NumberFlowLazy
        className={className}
        value={num / 100}
        format={{ style: "percent", maximumFractionDigits: 0 }}
      />
    );
  }
  return (
    <NumberFlowLazy
      className={className}
      value={num}
      format={{ maximumFractionDigits: 0 }}
    />
  );
}

/**
 * Animated numeric value for KPI cards. On SSR + the first client render we
 * emit a plain formatted string so hydration matches. After mount we lazily
 * load NumberFlow so subsequent value changes tween digit-by-digit.
 */
export default function KpiValue({ num, kind, className }: Props) {
  const hydrated = useHydrated();
  const plain = <span className={className}>{formatPlain(num, kind)}</span>;
  if (!hydrated) return plain;
  return (
    <Suspense fallback={plain}>
      <Animated num={num} kind={kind} className={className} />
    </Suspense>
  );
}
