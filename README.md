# claudemetry

A Cloudflare Worker, written in Rust, that proxies requests to the Anthropic API and records a structured row for every transaction into a **per-user SQLite database** (Durable Object with native SQL storage). Point `ANTHROPIC_BASE_URL` at it and every Claude Code (or Anthropic SDK) request becomes queryable, per account, forever.

Full passthrough: method, path, query, headers, and body are forwarded to `https://api.anthropic.com` unchanged. Streaming responses (SSE) are preserved — the client receives bytes immediately while the proxy captures the full body in the background via `ctx.wait_until`.

## Architecture

```
    Claude Code                        api.anthropic.com
         │                                    ▲
         │ POST /v1/messages                  │ unchanged
         ▼                                    │
  ┌──────────────────────────────────────────────┐
  │  cc-proxy (Rust Worker)                      │
  │                                              │
  │   identify         →  GET /oauth/profile     │
  │                        (cached in KV, 1h TTL)│
  │                        user_hash =           │
  │                        sha256(salt ‖ uuid)[:8]│
  │                                              │
  │   forward          →  streaming response     │──► client
  │                                              │
  │   ctx.wait_until:                            │
  │     parse SSE usage                          │
  │     stub = USER_STORE.id_from_name(hash)     │
  │     stub.fetch("/ingest", JSON record)      ─┼──┐
  └──────────────────────────────────────────────┘  │
                                                    ▼
                        ┌──────────────────────────────┐
                        │  UserStore Durable Object    │
                        │  (one instance per user_hash)│
                        │                              │
                        │  state.storage().sql()       │
                        │                              │
                        │  INSERT INTO transactions    │
                        │  (tx_id, ts, model,          │
                        │   input/output/cache tokens, │
                        │   stop_reason, tools, …)     │
                        └──────────────────────────────┘
```

Each unique user_hash gets its own private SQLite database. No provisioning — the first request with a given hash materializes the DO, runs `CREATE TABLE IF NOT EXISTS`, and inserts the row. Two users share no table, no index, no memory space.

## Requirements

Toolchain versions are pinned in `mise.toml`. With [mise](https://github.com/jdx/mise) installed and activated, bootstrap a fresh clone with:

```bash
mise trust          # one-time, approves this repo's mise.toml
just setup-mise     # installs rust/node/pnpm/just, wasm target, and worker-build
```

That's everything needed to run `just local` or `just deploy`. `worker-build` is a cargo-installed binary (lives in `~/.cargo/bin`, not pinned in `mise.toml`) — `mise.toml`'s `[env]` block puts `~/.cargo/bin` on PATH whenever you're inside the repo, so the setup is fully portable and doesn't rely on your global shell config.

Without mise, install the equivalents manually: Rust (with `wasm32-unknown-unknown`), Node ≥22.12, pnpm, [`just`](https://github.com/casey/just), and `cargo install worker-build`.

## Run locally

```bash
just local
```

Starts `wrangler dev` on `http://localhost:8787`. In another shell:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
claude   # or any Anthropic SDK client
```

Logs stream to the wrangler pane as JSON lines. To also capture them to a file:

```bash
just local-tee            # writes to proxy.log
just local-tee run.log    # custom path
```

## Deploy to Cloudflare

```bash
just login    # one-time, opens browser
just deploy
```

By default the worker is reachable at `https://cc-proxy.<your-subdomain>.workers.dev`. To use a custom domain, either uncomment the `routes` block in `wrangler.toml` (requires the zone to be on the same Cloudflare account) or bind the domain in the Cloudflare dashboard under Workers → cc-proxy → Settings → Domains & Routes.

Before sending traffic, generate and install a per-deployment salt so hashes aren't portable across deployments:

```bash
openssl rand -hex 16 | npx wrangler secret put HASH_SALT
```

If unset, the worker falls back to a published dev salt and emits hashes that aren't safe to publish.

Both workers share a single KV namespace (binding name `SESSION`) for the OAuth-profile cache (`tok:<token_id>`) and the email→hash link (`link:<email>`). Create one and paste the id into both `wrangler.toml` and `dashboard/wrangler.jsonc`:

```bash
npx wrangler kv namespace create claudemetry-session
# copy the id into the [[kv_namespaces]] block in both configs
```

Then point your client at whichever URL you ended up with:

```bash
export ANTHROPIC_BASE_URL=https://your-worker-url
```

View live logs with:

```bash
just tail
```

or in the Cloudflare dashboard (observability + traces are enabled in `wrangler.toml`).

## Identity: how user_hash is derived

Every request carries either an OAuth Bearer token (the usual Claude Code case) or an `x-api-key`. The proxy resolves both to a stable identity:

```
if   Bearer (OAuth)  →  GET https://api.anthropic.com/api/oauth/profile
                         (cached in KV under tok:<token_id>, TTL 1h)
                         user_hash = hex(sha256(SALT ‖ "uuid:" ‖ account.uuid))[:16]

if   x-api-key       →  user_hash = hex(sha256(SALT ‖ "apikey:" ‖ key))[:16]

else                  →  skip persistence
```

Anthropic's `account.uuid` is immutable per-account, so `user_hash` is genuinely stable across OAuth refreshes, devices, and months of use. The first request after a token refresh costs one ~150 ms profile fetch; everything after hits the KV cache. Two Anthropic accounts always produce two different hashes (and two different Durable Objects). The raw bearer is never stored or logged.

As a side-effect, every resolved request writes `link:<email> = user_hash` into the same KV namespace. The dashboard (gated by Cloudflare Access on the same email) reads that link to auto-scope itself to your DO — no `/setup` page, no copy-pasting.

If the profile endpoint is unreachable (transient outage, rate limit), the proxy falls back to a `raw:`-prefixed token hash. That hash will diverge on the next OAuth refresh, but self-heals as soon as a profile fetch succeeds again.

## Persistence: the `transactions` table

Each user's private SQLite contains a single table (migrations are idempotent, applied on first access to the DO):

| column                   | type    | source                                                              |
|--------------------------|---------|---------------------------------------------------------------------|
| `tx_id`                  | TEXT PK | Synthetic `inflight-<ts>-<rand>` assigned at request arrival        |
| `ts`                     | INT     | Request arrival time (ms since epoch)                               |
| `session_id`             | TEXT    | `x-claude-code-session-id` header                                   |
| `method`                 | TEXT    | HTTP method                                                          |
| `url`                    | TEXT    | Full upstream URL hit                                               |
| `status`                 | INT     | HTTP status returned by Anthropic                                    |
| `elapsed_ms`             | INT     | Total proxy-to-upstream-and-back latency                            |
| `model`                  | TEXT    | Model used, from `message_start`                                     |
| `input_tokens`           | INT     | Parsed from final usage snapshot                                     |
| `output_tokens`          | INT     | Parsed from final usage snapshot                                     |
| `cache_read`             | INT     | Prompt-cache reads                                                   |
| `cache_creation`         | INT     | Prompt-cache writes                                                  |
| `stop_reason`            | TEXT    | `end_turn`, `tool_use`, `max_tokens`, etc.                           |
| `tools_json`             | TEXT    | JSON array of tool names invoked in the turn                         |
| `req_body_bytes`         | INT     | Size of the forwarded request body                                  |
| `resp_body_bytes`        | INT     | Size of the captured response body                                  |
| `in_flight`              | INT     | 1 between `/ingest/start` and `/ingest/finalize`; 0 once done        |
| `anthropic_message_id`   | TEXT    | Anthropic's `message.id` (set on finalize)                           |
| `user_text`              | TEXT    | Last `user` message's text blocks + `tool_result` content (finalize) |
| `assistant_text`         | TEXT    | Concatenated `text_delta` from the SSE stream (finalize)             |

Indexed on `ts DESC`, `(session_id, ts)`, and a partial index on `ts` where `in_flight = 1` (backs the orphan sweep). An FTS5 virtual table (`transactions_fts`) mirrors `user_text` + `assistant_text` via sync triggers, and finalized turns are also embedded into a shared Vectorize index (`claudemetry-turns`, 768-dim, cosine) for semantic search — see **Search** below.

Each request writes the row twice. A placeholder (`in_flight = 1`, all metrics zero) is
inserted into the DO as soon as the request arrives, so the dashboard can show a spinner
while the upstream is still streaming. When the response completes, `/ingest/finalize`
overwrites the row with the real metrics and flips `in_flight` to 0. If the worker is
evicted between the two writes, the next fresh DO instance sweeps any placeholder older
than 5 min to `stop_reason = 'error'`.

### Search: `/_cm/search`

Hybrid FTS5 + Vectorize lookup over `user_text` and `assistant_text`. `mode`
defaults to `hybrid`; results from both indexes are merged via reciprocal-rank
fusion (k=60) and `match_source` tags each hit as `fts`, `vector`, or `both`.

```bash
curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/search \
  -d '{"q":"parse_sse_usage","mode":"fts"}'

curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/search \
  -d '{"q":"the OAuth debugging session","mode":"vector"}'

curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/search \
  -d '{"q":"auth flow","mode":"hybrid","limit":20}'
```

Isolation for Vectorize is enforced two ways: each vector is keyed
`{user_hash}:{tx_id}` and its `user_hash` metadata is used as a server-side
`filter` on every query. FTS5 is trivially isolated — it lives inside each
user's own Durable Object.

Provision the Vectorize index once before first deploy:

```bash
just vectorize-create        # idempotent; creates index + user_hash metadata index
just vectorize-info          # sanity check
```

## Admin probes

A handful of endpoints let you verify the pipeline without a dashboard. All are scoped to **your own** `user_hash` (resolved from your bearer / api-key) unless explicitly overridden:

```bash
# Your stable user_hash for this deployment
curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/whoami

# Aggregate counts + token totals from your DO's SQLite
curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/stats

# All raw rows from your DO (newest first)
curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/recent

# Generic SQL exec — backs `burnage shell`. Optional `hash` overrides the
# target DO (used for cross-DO inspection / data migration).
curl -H "Authorization: Bearer <token>" https://your-proxy/_cm/admin/sql \
  -d '{"sql":"SELECT model, COUNT(*) AS n FROM transactions GROUP BY model"}'
```

These are bearer-gated and never cross identities unless you ask via `hash`.

## `burnage shell`

Interactive SQL REPL + headless executor over `/_cm/admin/sql`. Built on crossterm — no readline, comfy-table, or rustyline pull-ins.

```bash
burnage shell                          # REPL against your own DO
burnage shell --hash 0203addab2792724  # REPL against another DO (admin)
burnage shell -c "SELECT COUNT(*) FROM transactions"
burnage shell -f migrate.sql
echo "SELECT model FROM transactions" | burnage shell
```

Output auto-detects: pretty table on a tty, JSON when stdout is piped. Override with `--format {table,json,tsv}`.

REPL niceties: history at `~/.cache/burnage/shell_history`, arrow-key navigation, Home/End/Ctrl-A/E/U/K/L, Ctrl-C cancels current input, Ctrl-D exits on empty buffer. Dot commands: `.tables`, `.schema [name]`, `.hash <16-hex>|-`, `.whoami`, `.quit`.

## What gets logged (console)

Each transaction also emits two structured JSON log lines to `wrangler tail`:

```json
{"dir":"req","ts":...,"method":"POST","url":"...","user_hash":"0203…","session_id":"…","body_len":1530}
{"dir":"resp","ts":...,"status":200,"elapsed_ms":777,"model":"claude-opus-4-6","input_tokens":443,"output_tokens":32,"cache_read":262754,"cache_creation":951,"stop_reason":"end_turn","tx_id":"msg_…","body_len":2472}
```

`authorization` and `x-api-key` values are never written to logs. The raw prompt/response bodies are not logged in the deployed worker either — they're parsed for metrics (and for the `user_text` / `assistant_text` search columns) and then discarded.

## Layout

- `src/lib.rs` — fetch handler, `UserStore` Durable Object, SSE parser, user-hash derivation, admin probes
- `wrangler.toml` — proxy worker config (Durable Object binding + SQLite migration, observability on)
- `dashboard/` — Astro 6 + React dashboard worker, served behind Cloudflare Access
- `scripts/cf-access.sh` — idempotent provisioner for the Access apps/policies (`just cf-access`)
- `justfile` — `local`, `local-tee`, `build`, `login`, `deploy`, `tail`, `clean`, `dashboard-dev`, `dashboard-deploy`, `dashboard-tail`, `deploy-all`, `cf-access`

## Notes on trust

The proxy does not authenticate callers. Anyone with the deployed URL can use it as an open relay to Anthropic (they still need their own Anthropic credentials, which are forwarded as-is). If that matters for your deployment, add a shared-secret header check at the top of `fetch` in `src/lib.rs`, or put the worker behind Cloudflare Access.

The operator of the proxy has in-memory access to your raw token and prompt bodies while a request is in flight — this is unavoidable for any proxy. The code persists parsed metrics **plus the text of the last user-turn message (including `tool_result` payloads) and the assistant's text output**, so that `/_cm/search` (FTS5 + Vectorize) is useful. `tool_result` blocks often contain file contents or command output that your assistant saw — treat the DO's SQLite as sensitive accordingly. If you want stronger guarantees, the source is small and trivial to fork and run on your own Cloudflare account; disabling search is a one-line change (skip the `user_text` / `assistant_text` fields in `TransactionRecord`).
