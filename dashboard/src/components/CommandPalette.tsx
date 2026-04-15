import * as React from "react";
import {
  Search,
  Sparkles,
  Type,
  Layers,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { fmtAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

type Mode = "hybrid" | "fts" | "vector";

type Hit = {
  tx_id: string;
  ts: number;
  session_id: string | null;
  model: string | null;
  user_snip: string | null;
  asst_snip: string | null;
  score: number;
  match_source: "fts" | "vector" | "both" | "unknown";
};

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; retryAfter?: number }
  | { kind: "results"; mode: Mode; hits: Hit[]; query: string };

const MODES: {
  value: Mode;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "hybrid", label: "Hybrid", hint: "Both indexes, merged (RRF)", Icon: Layers },
  { value: "fts", label: "Keyword", hint: "Exact tokens via FTS5/bm25", Icon: Type },
  { value: "vector", label: "Semantic", hint: "Embedding cosine similarity", Icon: Sparkles },
];

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("hybrid");
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const [active, setActive] = React.useState(0);
  const reqIdRef = React.useRef(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLOListElement>(null);

  // Focus input on open; reset when closed.
  React.useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery("");
      setState({ kind: "idle" });
      setActive(0);
    }
  }, [open]);

  // Debounced search.
  React.useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setState({ kind: "idle" });
      return;
    }
    const myReqId = ++reqIdRef.current;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      setState({ kind: "loading" });
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q, mode, limit: 20 }),
        });
        if (myReqId !== reqIdRef.current) return;
        if (res.status === 429) {
          const body = (await res.json().catch(() => null)) as {
            retry_after_seconds?: number;
          } | null;
          setState({
            kind: "error",
            message: "Rate limit hit. Give it a moment.",
            retryAfter: body?.retry_after_seconds,
          });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: `Search failed (${res.status}).` });
          return;
        }
        const data = (await res.json()) as { mode: Mode; results: Hit[] };
        setState({ kind: "results", mode: data.mode, hits: data.results, query: q });
        setActive(0);
      } catch (e) {
        if (myReqId !== reqIdRef.current) return;
        if ((e as Error).name === "AbortError") return;
        setState({ kind: "error", message: (e as Error).message || "Network error" });
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [query, mode, open]);

  // Global keyboard: Escape closes; arrows navigate; Enter opens selected hit.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (state.kind !== "results" || state.hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(state.hits.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = state.hits[active];
        if (hit) openHit(hit);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, state, active]);

  // Keep active hit in view.
  React.useEffect(() => {
    if (state.kind !== "results") return;
    const el = listRef.current?.querySelector<HTMLLIElement>(
      `li[data-idx="${active}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active, state]);

  const openHit = (hit: Hit) => {
    if (!hit.session_id) return;
    window.location.href = `/session/${encodeURIComponent(hit.session_id)}#${encodeURIComponent(hit.tx_id)}`;
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-24 sm:pt-32"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] shadow-2xl shadow-black/40">
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3">
          <Search className="size-4 text-[var(--color-subtle-foreground)]" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions, prompts, responses…"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 h-12 bg-transparent text-sm outline-none placeholder:text-[var(--color-subtle-foreground)]"
          />
          <div className="flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-card-elevated)]/40 p-0.5">
            {MODES.map((m) => {
              const isActive = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setMode(m.value)}
                  title={m.hint}
                  className={cn(
                    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
                    isActive
                      ? "bg-[var(--color-card)] text-[var(--color-foreground)] shadow-[inset_0_0_0_1px_var(--color-border)]"
                      : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
                  )}
                >
                  <m.Icon className="size-3" />
                  {m.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] font-mono"
            aria-label="Close (Esc)"
          >
            esc
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
          <Body
            state={state}
            mode={mode}
            query={query.trim()}
            active={active}
            listRef={listRef}
            onPick={openHit}
            onHover={setActive}
          />
        </div>
        <div className="border-t border-[var(--color-border)] px-3 py-2 flex items-center gap-3 text-[10px] text-[var(--color-subtle-foreground)] font-mono">
          <span><kbd className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-card-elevated)] px-1 py-0 font-mono text-[9px] text-[var(--color-muted-foreground)]">↑</kbd> <kbd className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-card-elevated)] px-1 py-0 font-mono text-[9px] text-[var(--color-muted-foreground)]">↓</kbd> navigate</span>
          <span><kbd className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-card-elevated)] px-1 py-0 font-mono text-[9px] text-[var(--color-muted-foreground)]">enter</kbd> open</span>
          <span><kbd className="inline-flex items-center rounded border border-[var(--color-border)] bg-[var(--color-card-elevated)] px-1 py-0 font-mono text-[9px] text-[var(--color-muted-foreground)]">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

function Body({
  state,
  mode,
  query,
  active,
  listRef,
  onPick,
  onHover,
}: {
  state: State;
  mode: Mode;
  query: string;
  active: number;
  listRef: React.RefObject<HTMLOListElement | null>;
  onPick: (h: Hit) => void;
  onHover: (i: number) => void;
}) {
  if (state.kind === "idle") {
    return (
      <div className="px-3 py-6 text-center text-xs text-[var(--color-subtle-foreground)]">
        {query.length === 0
          ? "Start typing to search your sessions."
          : "Keep typing — at least 2 characters."}
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--color-subtle-foreground)]">
        <Loader2 className="size-3 animate-spin" />
        Searching…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-start gap-2 px-3 py-3 text-xs text-[var(--color-muted-foreground)]">
        <AlertCircle className="mt-0.5 size-3.5 text-amber-400/80" />
        <div>
          {state.message}
          {state.retryAfter ? ` Retry in ~${state.retryAfter}s.` : null}
        </div>
      </div>
    );
  }
  if (state.hits.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <Search className="size-5 text-[var(--color-subtle-foreground)]" />
        <div className="text-xs text-[var(--color-muted-foreground)]">
          No matches for{" "}
          <span className="font-medium text-[var(--color-foreground)]">
            “{state.query}”
          </span>
          .
        </div>
        {mode === "vector" ? (
          <div className="text-[11px] text-[var(--color-subtle-foreground)]">
            Try another phrasing, or switch to Keyword / Hybrid.
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <ol ref={listRef} className="flex flex-col gap-0.5">
      {state.hits.map((h, i) => (
        <HitRow
          key={h.tx_id}
          hit={h}
          active={i === active}
          idx={i}
          onPick={onPick}
          onHover={onHover}
        />
      ))}
    </ol>
  );
}

function HitRow({
  hit,
  active,
  idx,
  onPick,
  onHover,
}: {
  hit: Hit;
  active: boolean;
  idx: number;
  onPick: (h: Hit) => void;
  onHover: (i: number) => void;
}) {
  return (
    <li data-idx={idx}>
      <button
        type="button"
        onMouseEnter={() => onHover(idx)}
        onClick={() => onPick(hit)}
        className={cn(
          "group block w-full rounded-md px-2.5 py-2 text-left",
          active
            ? "bg-[var(--color-card-elevated)]/80"
            : "hover:bg-[var(--color-card-elevated)]/40",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[10.5px]">
          <MatchBadge source={hit.match_source} />
          {hit.model ? (
            <span className="font-mono text-[var(--color-muted-foreground)]">
              {hit.model}
            </span>
          ) : null}
          <span className="text-[var(--color-subtle-foreground)]">·</span>
          <span className="text-[var(--color-subtle-foreground)]">
            {fmtAgo(hit.ts)}
          </span>
          <span className="ml-auto font-mono tabular-nums text-[var(--color-subtle-foreground)]">
            {hit.score.toFixed(3)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          {hit.user_snip ? <Snip role="you" text={hit.user_snip} /> : null}
          {hit.asst_snip ? <Snip role="asst" text={hit.asst_snip} /> : null}
        </div>
      </button>
    </li>
  );
}

function Snip({ role, text }: { role: "you" | "asst"; text: string }) {
  return (
    <div className="flex gap-2.5 text-xs leading-relaxed">
      <span
        className={cn(
          "mt-[1px] shrink-0 select-none font-mono text-[9.5px] uppercase tracking-[0.08em]",
          role === "you"
            ? "text-sky-400/70"
            : "text-[var(--color-subtle-foreground)]",
        )}
      >
        {role}
      </span>
      <span
        className={cn(
          "text-[var(--color-muted-foreground)] line-clamp-2",
          "[&>mark]:rounded [&>mark]:bg-yellow-400/25 [&>mark]:px-0.5",
          "[&>mark]:text-[var(--color-foreground)] [&>mark]:font-medium",
        )}
        // Snippets contain <mark> tags from SQLite's snippet() function.
        dangerouslySetInnerHTML={{ __html: text }}
      />
    </div>
  );
}

function MatchBadge({ source }: { source: Hit["match_source"] }) {
  const styles: Record<Hit["match_source"], string> = {
    fts: "bg-sky-500/10 text-sky-300 ring-sky-500/20",
    vector: "bg-violet-500/10 text-violet-300 ring-violet-500/20",
    both: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20",
    unknown: "bg-neutral-500/10 text-neutral-400 ring-neutral-500/20",
  };
  const label: Record<Hit["match_source"], string> = {
    fts: "keyword",
    vector: "semantic",
    both: "both",
    unknown: "?",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-[1px] font-mono text-[9px] font-medium uppercase tracking-[0.08em] ring-1 ring-inset",
        styles[source],
      )}
    >
      {label[source]}
    </span>
  );
}
