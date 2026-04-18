import { useEffect, useState } from "react";
import type { SessionSummary } from "@/lib/sessions";
import { fmtAgo, fmtDuration, fmtUsd } from "@/lib/format";
import { subscribeSessions, seedSessions } from "@/lib/sessionsBus";
import { useHydrated } from "@/hooks/use-hydrated";

function shortSession(id: string): string {
  return id.slice(0, 8);
}

function sessionModels(s: SessionSummary): string {
  if (!s.topModel) return "—";
  return s.modelCount > 1 ? `${s.topModel} +${s.modelCount - 1}` : s.topModel;
}

export default function LiveSessionGrid({
  initialSessions,
}: {
  initialSessions: SessionSummary[];
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>(initialSessions);
  const hydrated = useHydrated();

  useEffect(() => {
    seedSessions(initialSessions);
    return subscribeSessions(setSessions);
  }, [initialSessions]);

  if (sessions.length === 0) return null;

  const activeCount = sessions.filter((s) => s.active).length;
  // Render enough cards so Active mode shows every active session, while
  // All mode keeps its familiar top-8 feel.
  const sessionCards = sessions.slice(0, Math.max(8, activeCount));

  return (
    <section className="mb-8" data-live-region="sessions">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium">By session</h2>
          <div
            className="session-toggle"
            role="tablist"
            aria-label="Filter sessions"
          >
            <button
              type="button"
              role="tab"
              data-session-filter-btn
              data-mode="active"
            >
              <span className="live-dot" />
              Active
            </button>
            <button
              type="button"
              role="tab"
              data-session-filter-btn
              data-mode="all"
            >
              All
            </button>
          </div>
        </div>
        <span className="text-xs text-[var(--color-subtle-foreground)] tabular-nums">
          <span data-count-when="active">{activeCount} active</span>
          <span data-count-when="all">{sessions.length} sessions</span>
        </span>
      </div>
      {activeCount === 0 && (
        <div
          data-empty-when="active"
          className="card p-6 mb-3 flex items-center justify-between gap-4"
        >
          <div>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No active sessions right now.
            </p>
            <p className="text-xs text-[var(--color-subtle-foreground)] mt-1">
              A session is active within 3 min of its last turn.
            </p>
          </div>
          <button
            type="button"
            className="session-toggle-link"
            data-session-filter-btn
            data-mode="all"
          >
            Show all →
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        {sessionCards.map((s) => {
          const active = s.active;
          return (
            <a
              key={s.id}
              href={`/session/${s.id}`}
              className={`card card-hover p-4 block ${
                active
                  ? "ring-1 ring-[var(--color-good-muted)] ring-offset-0"
                  : ""
              }`}
              data-session-card
              data-session-id={s.id}
              data-session-active={active ? "true" : "false"}
              data-last-ts={s.lastTs}
            >
              <div className="flex items-baseline justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <code className="font-mono text-xs text-[var(--color-volume)]">
                    {shortSession(s.id)}
                  </code>
                  {active && (
                    <span className="flex items-center gap-1 text-[0.625rem] uppercase tracking-wider text-[var(--color-good)]">
                      <span className="live-dot" />
                      active
                    </span>
                  )}
                </div>
                <span className="text-[0.6875rem] uppercase tracking-wider text-[var(--color-subtle-foreground)]">
                  <span
                    data-ts={s.lastTs}
                    data-ts-suffix=" ago"
                    suppressHydrationWarning
                  >
                    {hydrated ? `${fmtAgo(s.lastTs)} ago` : ""}
                  </span>
                </span>
              </div>
              <div className="flex items-end justify-between">
                <div>
                  <p className="font-mono text-xl font-semibold tabular-nums">
                    {s.turns}
                    <span className="text-[var(--color-subtle-foreground)] text-xs font-normal ml-1">
                      turns
                    </span>
                  </p>
                  <p className="text-xs text-[var(--color-muted-foreground)] mt-1 font-mono">
                    {sessionModels(s)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm tabular-nums text-[var(--color-money)]">
                    {fmtUsd(s.costUsd)}
                  </p>
                  <p className="text-xs text-[var(--color-subtle-foreground)] tabular-nums mt-1">
                    {fmtDuration(s.lastTs - s.firstTs)}
                  </p>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}
