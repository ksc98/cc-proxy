import * as React from "react";
import { Search, Sparkles, Type, Layers, Loader2, AlertCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
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

type SearchState =
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

export function SearchBox() {
  const [query, setQuery] = React.useState("");
  const [mode, setMode] = React.useState<Mode>("hybrid");
  const [state, setState] = React.useState<SearchState>({ kind: "idle" });
  const reqIdRef = React.useRef(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Press `/` anywhere to focus the search input — only when the user isn't
  // already typing in a form field. Small, cheap, feels expensive.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const editable = (e.target as HTMLElement | null)?.isContentEditable;
      if (editable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  React.useEffect(() => {
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
          setState({
            kind: "error",
            message: `Search failed (${res.status}).`,
          });
          return;
        }
        const data = (await res.json()) as { mode: Mode; results: Hit[] };
        setState({
          kind: "results",
          mode: data.mode,
          hits: data.results,
          query: q,
        });
      } catch (e) {
        if (myReqId !== reqIdRef.current) return;
        if ((e as Error).name === "AbortError") return;
        setState({
          kind: "error",
          message: (e as Error).message || "Network error",
        });
      }
    }, 300);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [query, mode]);

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium tracking-tight text-[var(--color-foreground)]">
            Search sessions
          </h2>
          <p className="text-xs text-[var(--color-subtle-foreground)]">
            Keyword (FTS5), semantic (Vectorize), or both.
          </p>
        </div>
        <ModeSwitch mode={mode} onChange={setMode} />
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-subtle-foreground)]" />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions, prompts, responses…"
          autoComplete="off"
          spellCheck={false}
          className="h-11 pl-10 pr-12 text-sm"
        />
        <Kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 h-6 px-2 text-[11px] font-medium">
          /
        </Kbd>
      </div>

      <ResultsPanel state={state} mode={mode} query={query.trim()} />
    </section>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Search mode"
      className="inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-0.5"
    >
      {MODES.map((m) => {
        const active = mode === m.value;
        return (
          <button
            key={m.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(m.value)}
            title={m.hint}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-[var(--color-card-elevated)] text-[var(--color-foreground)] shadow-[inset_0_0_0_1px_var(--color-border)]"
                : "text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]",
            )}
          >
            <m.Icon className="size-3" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function ResultsPanel({
  state,
  mode,
  query,
}: {
  state: SearchState;
  mode: Mode;
  query: string;
}) {
  if (state.kind === "idle") {
    if (query.length === 0) return null;
    return (
      <div className="text-xs text-[var(--color-subtle-foreground)]">
        Keep typing — at least 2 characters.
      </div>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--color-subtle-foreground)]">
        <Loader2 className="size-3 animate-spin" />
        Searching…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2 text-xs text-[var(--color-muted-foreground)]">
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
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-[var(--color-border)] px-4 py-8 text-center">
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-[var(--color-subtle-foreground)]">
        <span>
          {state.hits.length}{" "}
          {state.hits.length === 1 ? "result" : "results"} · {state.mode}
        </span>
      </div>
      <ol className="flex flex-col gap-1.5">
        {state.hits.map((h) => (
          <HitCard key={h.tx_id} hit={h} />
        ))}
      </ol>
    </div>
  );
}

function HitCard({ hit }: { hit: Hit }) {
  const href = hit.session_id
    ? `/session/${encodeURIComponent(hit.session_id)}#${encodeURIComponent(hit.tx_id)}`
    : undefined;
  const Wrapper = href ? "a" : "div";
  const wrapperProps = href ? { href } : {};
  return (
    <li>
      <Wrapper
        {...wrapperProps}
        className={cn(
          "group block rounded-md border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-2.5",
          "transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-elevated)]/50",
          href ? "cursor-pointer" : "",
        )}
      >
        <div className="mb-1.5 flex items-center gap-2 text-[10.5px]">
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
        <div className="flex flex-col gap-1">
          {hit.user_snip ? <SnippetRow role="you" text={hit.user_snip} /> : null}
          {hit.asst_snip ? <SnippetRow role="asst" text={hit.asst_snip} /> : null}
        </div>
      </Wrapper>
    </li>
  );
}

function SnippetRow({ role, text }: { role: "you" | "asst"; text: string }) {
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
        // The text between marks is escaped by SQLite; trusted output.
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

function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 select-none items-center justify-center rounded border border-[var(--color-border)] bg-[var(--color-card-elevated)] px-1.5 font-mono text-[10px] text-[var(--color-muted-foreground)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
