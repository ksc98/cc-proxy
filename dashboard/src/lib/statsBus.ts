// Page-wide pub/sub for the all-time stats snapshot. Mirrors sessionsBus:
// one singleton bundle-scoped store, an in-flight flag to dedupe, seeded
// from SSR so the first subscriber renders without a fetch, and wired to
// the same `cm:turn-complete` / `cm:session-end` WS events that WsClient
// dispatches. Lets the KPI card island re-render live values without
// re-mounting (so NumberFlow tweens instead of resetting).

import type { Stats } from "@/lib/store";

type Listener = (stats: Stats) => void;

const listeners = new Set<Listener>();
let latest: Stats | null = null;
let inflight = false;
let wired = false;

async function fetchOnce(): Promise<void> {
  if (inflight) return;
  if (typeof document !== "undefined" && document.hidden) return;
  inflight = true;
  try {
    const res = await fetch("/api/stats", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as Stats;
    if (data && typeof data === "object" && "turns" in data) {
      latest = data;
      listeners.forEach((fn) => {
        try {
          fn(data);
        } catch {
          /* one bad subscriber shouldn't break the others */
        }
      });
    }
  } catch {
    /* next event will retry */
  } finally {
    inflight = false;
  }
}

function ensureWired(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  const tick = () => void fetchOnce();
  window.addEventListener("cm:turn-complete", tick);
  window.addEventListener("cm:session-end", tick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
}

export function subscribeStats(fn: Listener): () => void {
  ensureWired();
  listeners.add(fn);
  if (latest) fn(latest);
  return () => {
    listeners.delete(fn);
  };
}

/** Seed the cache from SSR data so the first subscriber has something to
 * show without a network round-trip. */
export function seedStats(stats: Stats): void {
  if (latest) return;
  latest = stats;
}

export function latestStats(): Stats | null {
  return latest;
}
