// Page-wide pub/sub for the session summary list. Sidebar and
// RecentTurnsTable both need fresh session data on every turn_complete /
// session_end — previously each component ran its own independent poll,
// so every event fired two identical /api/sessions.json requests. This
// module funnels all subscribers through a single in-flight-guarded
// fetcher.
//
// Design mirrors rowsBus: one singleton bundle-scoped store, in-memory
// cache of the latest snapshot for late subscribers, and a shared
// fetcher gated on document visibility + an inflight flag.

import type { SessionSummary } from "@/lib/sessions";

type Listener = (sessions: SessionSummary[]) => void;

const listeners = new Set<Listener>();
let latest: SessionSummary[] | null = null;
let inflight = false;
let wired = false;

async function fetchOnce(): Promise<void> {
  if (inflight) return;
  if (typeof document !== "undefined" && document.hidden) return;
  inflight = true;
  try {
    const res = await fetch("/api/sessions.json", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = (await res.json()) as SessionSummary[];
    if (Array.isArray(data)) {
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

/** Wire the shared fetcher to WS events + visibility. Idempotent. */
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

export function subscribeSessions(fn: Listener): () => void {
  ensureWired();
  listeners.add(fn);
  if (latest) fn(latest);
  return () => {
    listeners.delete(fn);
  };
}

/** Seed the cache from SSR data so the first subscriber has something
 * to show without a network round-trip. */
export function seedSessions(sessions: SessionSummary[]): void {
  if (latest) return;
  latest = sessions;
}
