import * as React from "react";

export function ModelMixInline({
  models,
  turns,
  colorFor,
}: {
  models: Map<string, number>;
  turns: number;
  colorFor: (model: string) => string;
}) {
  const sorted = React.useMemo(
    () => [...models.entries()].sort((a, b) => b[1] - a[1]),
    [models],
  );
  const title = sorted
    .map(([m, n]) => `${m} ×${n} (${Math.round((n / turns) * 100)}%)`)
    .join("\n");
  return (
    <span
      className="inline-flex overflow-hidden rounded-sm bg-[var(--color-border)]"
      style={{ width: 72, height: 6 }}
      aria-hidden="true"
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {sorted.map(([label, n]) => (
        <span
          key={label}
          style={{
            flex: `${Math.max((n / turns) * 100, 2)} 0 0`,
            minWidth: 1,
            background: colorFor(label),
          }}
        />
      ))}
    </span>
  );
}
