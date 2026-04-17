import * as React from "react";

/**
 * Returns `false` during SSR and the very first client render, then flips
 * to `true` after the first effect runs.
 *
 * Use it to gate any render output that would otherwise differ between the
 * server and the client — e.g. relative timestamps that depend on
 * `Date.now()`, locale-formatted strings, or values pulled from the URL or
 * localStorage. Pair with `suppressHydrationWarning` on the wrapping element
 * so React's text-mismatch reporter stays silent for the first paint.
 *
 * Pattern:
 *   const hydrated = useHydrated();
 *   return <span suppressHydrationWarning>{hydrated ? fmtAgo(ts) : ""}</span>;
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}
