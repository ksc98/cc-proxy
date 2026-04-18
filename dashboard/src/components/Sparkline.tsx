// Pure-SVG sparkline, no JS after render. Used by both the client-side
// LiveKpiGrid (subscribes to rowsBus) and Astro-side KpiCard.astro (static
// SSR). Supports the "line" and "bars" modes — the area variant and the
// min/max dots from the previous .astro implementation aren't used
// anywhere, so we keep the surface area minimal.

type Mode = "line" | "bars";

interface Props {
  values: number[];
  mode?: Mode;
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  strokeWidth?: number;
}

export default function Sparkline({
  values,
  mode = "line",
  width = 120,
  height = 32,
  color = "var(--color-volume)",
  fillOpacity = 0.18,
  strokeWidth = 1.5,
}: Props) {
  const safeVals = values.length > 0 ? values : [0];
  const min = Math.min(...safeVals);
  const max = Math.max(...safeVals);
  const range = max - min || 1;
  const n = safeVals.length;

  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => {
    const t = (v - min) / range;
    return height - t * (height - 2) - 1;
  };

  let pathD = "";
  let areaD = "";
  if (mode === "line") {
    pathD = safeVals
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
      .join(" ");
    areaD =
      `M0 ${height} ` +
      safeVals.map((v, i) => `L${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ") +
      ` L${width} ${height} Z`;
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block"
      style={{ maxWidth: `${width}px`, width: "100%", height: `${height}px` }}
      aria-hidden="true"
    >
      {mode === "line" && (
        <>
          <path d={areaD} fill={color} fillOpacity={fillOpacity} />
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {mode === "bars" &&
        safeVals.map((v, i) => {
          const slot = width / n;
          const gap = Math.min(1, slot * 0.15);
          const barW = Math.max(0.5, slot - gap);
          const barX = i * slot + gap / 2;
          const h = ((v - min) / range) * (height - 2);
          const barY = height - h - 1;
          return (
            <rect
              key={i}
              x={barX.toFixed(2)}
              y={barY.toFixed(2)}
              width={barW.toFixed(2)}
              height={Math.max(1, h).toFixed(2)}
              fill={color}
              rx="0.5"
            />
          );
        })}
    </svg>
  );
}
