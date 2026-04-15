use js_sys::Uint8Array;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use worker::durable::State;
use worker::kv::KvStore;
use worker::*;

const UPSTREAM: &str = "https://api.anthropic.com";
const DEFAULT_SALT: &str = "claudemetry-dev-unset";

// ---------- Top-level fetch (proxy) ----------

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, ctx: Context) -> Result<Response> {
    let start = Date::now().as_millis() as i64;
    let method = req.method();
    let url = req.url()?;
    let path = url.path().to_string();
    let query = url.query().map(|q| format!("?{}", q)).unwrap_or_default();
    let target = format!("{}{}{}", UPSTREAM, path, query);

    let salt = env
        .secret("HASH_SALT")
        .map(|s| s.to_string())
        .unwrap_or_else(|_| DEFAULT_SALT.to_string());

    let req_headers_vec: Vec<(String, String)> = req.headers().entries().collect();

    // Internal admin probes — bypass the proxy. Caller must present a Bearer
    // token / api key; we only ever query their own user_hash's DO.
    if path.starts_with("/_cm/") {
        let body = req.bytes().await.unwrap_or_default();
        return admin_route(&path, &method, &body, &req_headers_vec, &salt, &env).await;
    }

    let req_body_bytes = req.bytes().await.unwrap_or_default();
    let req_body_len = req_body_bytes.len() as i64;

    let user_hash = compute_user_hash(&req_headers_vec, &salt, &env)
        .await
        .map(|(h, _email)| h);
    let session_id = header_value(&req_headers_vec, "x-claude-code-session-id");

    // Quick request log line (kept for tail visibility).
    let req_log = json!({
        "ts": start,
        "dir": "req",
        "user_hash": user_hash,
        "session_id": session_id,
        "method": method.to_string(),
        "url": target,
        "body_len": req_body_len,
    });
    console_log!("{}", req_log.to_string());

    // Build the outbound request: copy headers minus the hop-by-hop / CF noise.
    let out_headers = Headers::new();
    for (k, v) in &req_headers_vec {
        let lk = k.to_ascii_lowercase();
        if matches!(
            lk.as_str(),
            "host"
                | "content-length"
                | "cf-connecting-ip"
                | "cf-ipcountry"
                | "cf-ray"
                | "cf-visitor"
                | "x-forwarded-for"
                | "x-forwarded-proto"
                | "x-real-ip"
        ) {
            continue;
        }
        out_headers.append(k, v).ok();
    }

    let mut init = RequestInit::new();
    init.with_method(method.clone());
    init.with_headers(out_headers);
    if !req_body_bytes.is_empty() {
        let arr = Uint8Array::from(&req_body_bytes[..]);
        init.with_body(Some(arr.into()));
    }

    let upstream_req = Request::new_with_init(&target, &init)?;
    let mut resp = Fetch::Request(upstream_req).send().await?;

    // Clone for out-of-band consumption; client-bound stream stays untouched.
    let resp_for_log = resp.cloned()?;
    let status = resp.status_code() as i32;
    let method_str = method.to_string();
    let target_for_record = target.clone();
    let resp_headers_vec: Vec<(String, String)> = resp.headers().entries().collect();
    let req_body_for_parse = req_body_bytes.clone();

    // Acquire the per-user DO stub up front so the future is Send-clean.
    let stub = user_hash.as_ref().and_then(|uh| {
        let ns = env.durable_object("USER_STORE").ok()?;
        let id = ns.id_from_name(uh).ok()?;
        id.get_stub().ok()
    });

    ctx.wait_until(async move {
        let mut r = resp_for_log;
        let body = r.bytes().await.unwrap_or_default();
        let body_str = String::from_utf8_lossy(&body);
        let stats = parse_sse_usage(&body_str);
        let elapsed = Date::now().as_millis() as i64 - start;

        let tx_id = stats
            .tx_id
            .clone()
            .unwrap_or_else(|| format!("{}-{:08x}", start, js_sys::Math::random().to_bits() as u32));
        let tools_json = if stats.tools.is_empty() {
            None
        } else {
            serde_json::to_string(&stats.tools).ok()
        };

        // Request-side knobs. Cheap to parse — the body is already in memory.
        let (max_tokens, thinking_budget) = parse_request_body(&req_body_for_parse);
        let (rl_req_remaining, rl_req_limit, rl_tok_remaining, rl_tok_limit) =
            parse_rate_limits(&resp_headers_vec);

        let record = TransactionRecord {
            tx_id,
            ts: start,
            session_id,
            method: method_str,
            url: target_for_record,
            status,
            elapsed_ms: elapsed,
            model: stats.model,
            input_tokens: stats.input_tokens,
            output_tokens: stats.output_tokens,
            cache_read: stats.cache_read,
            cache_creation: stats.cache_creation,
            stop_reason: stats.stop_reason,
            tools_json,
            req_body_bytes: req_body_len,
            resp_body_bytes: body.len() as i64,
            cache_creation_5m: if stats.cache_creation_5m > 0 {
                Some(stats.cache_creation_5m)
            } else {
                None
            },
            cache_creation_1h: if stats.cache_creation_1h > 0 {
                Some(stats.cache_creation_1h)
            } else {
                None
            },
            thinking_budget,
            thinking_blocks: if stats.thinking_blocks > 0 {
                Some(stats.thinking_blocks)
            } else {
                None
            },
            max_tokens,
            rl_req_remaining,
            rl_req_limit,
            rl_tok_remaining,
            rl_tok_limit,
        };

        // Always emit a structured response log so wrangler tail still works.
        let log = json!({
            "ts": Date::now().as_millis() as i64,
            "dir": "resp",
            "user_hash": user_hash,
            "session_id": record.session_id,
            "tx_id": record.tx_id,
            "status": status,
            "elapsed_ms": elapsed,
            "model": record.model,
            "input_tokens": record.input_tokens,
            "output_tokens": record.output_tokens,
            "cache_read": record.cache_read,
            "cache_creation": record.cache_creation,
            "stop_reason": record.stop_reason,
            "tools": record.tools_json,
            "body_len": record.resp_body_bytes,
        });
        console_log!("{}", log.to_string());

        if let Some(stub) = stub {
            let body_json = serde_json::to_string(&record).unwrap_or_default();
            let arr = Uint8Array::from(body_json.as_bytes());
            let mut init = RequestInit::new();
            init.with_method(Method::Post);
            init.with_body(Some(arr.into()));
            // Hostname here is irrelevant — the stub routes by binding, not URL.
            if let Ok(req) = Request::new_with_init("https://store/ingest", &init) {
                if let Err(e) = stub.fetch_with_request(req).await {
                    console_log!("{{\"dir\":\"do_ingest_err\",\"err\":\"{:?}\"}}", e);
                }
            }
        }
    });

    Ok(resp)
}

// ---------- Admin probes ----------

async fn admin_route(
    path: &str,
    method: &Method,
    body: &[u8],
    headers: &[(String, String)],
    salt: &str,
    env: &Env,
) -> Result<Response> {
    let (user_hash, email) = match compute_user_hash(headers, salt, env).await {
        Some(pair) => pair,
        None => return Response::error("missing authorization", 401),
    };

    if path == "/_cm/whoami" {
        return Response::from_json(&json!({
            "user_hash": user_hash,
            "email": email,
        }));
    }

    // /_cm/admin/sql supports a hash override in the body for cross-DO
    // inspection + data migration. Everything else operates on the caller's
    // own DO.
    let mut target_hash = user_hash.clone();
    let mut forwarded_body: Vec<u8> = body.to_vec();

    let (inner_method, inner_path) = match (method, path) {
        (&Method::Get, "/_cm/recent") => (Method::Get, "/recent"),
        (&Method::Get, "/_cm/stats") => (Method::Get, "/stats"),
        (&Method::Get, "/_cm/sessions/ends") => (Method::Get, "/session/ends"),
        (&Method::Post, "/_cm/session/end") => (Method::Post, "/session/end"),
        (&Method::Post, "/_cm/admin/sql") => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&forwarded_body) {
                if let Some(h) = v.get("hash").and_then(|x| x.as_str()) {
                    if !is_hex16(h) {
                        return Response::error("hash must be 16 hex chars", 400);
                    }
                    target_hash = h.to_string();
                }
                // Re-serialize without the `hash` field so the DO sees a
                // clean `{sql, params}` body.
                if let Some(obj) = v.as_object() {
                    let mut trimmed = obj.clone();
                    trimmed.remove("hash");
                    forwarded_body =
                        serde_json::to_vec(&trimmed).unwrap_or(forwarded_body);
                }
            }
            (Method::Post, "/sql")
        }
        _ => return Response::error("unknown admin route", 404),
    };

    let ns = env.durable_object("USER_STORE")?;
    let id = ns.id_from_name(&target_hash)?;
    let stub = id.get_stub()?;

    let inner_url = format!("https://store{}", inner_path);
    let mut init = RequestInit::new();
    init.with_method(inner_method);
    if !forwarded_body.is_empty() {
        let arr = Uint8Array::from(&forwarded_body[..]);
        init.with_body(Some(arr.into()));
        let h = Headers::new();
        h.append("content-type", "application/json").ok();
        init.with_headers(h);
    }
    let req = Request::new_with_init(&inner_url, &init)?;
    stub.fetch_with_request(req).await
}

fn is_hex16(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ---------- Per-user Durable Object with SQLite ----------

#[durable_object]
pub struct UserStore {
    state: State,
    _env: Env,
    initialized: std::cell::Cell<bool>,
}

impl DurableObject for UserStore {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            _env: env,
            initialized: std::cell::Cell::new(false),
        }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        self.ensure_init();
        let url = req.url()?;
        let path = url.path().to_string();
        match (req.method(), path.as_str()) {
            (Method::Post, "/ingest") => self.ingest(&mut req).await,
            (Method::Post, "/session/end") => self.end_session(&mut req).await,
            (Method::Get, "/session/ends") => self.session_ends().await,
            (Method::Get, "/recent") => self.recent().await,
            (Method::Get, "/stats") => self.stats().await,
            (Method::Post, "/sql") => self.sql_exec(&mut req).await,
            _ => Response::error("not found", 404),
        }
    }
}

impl UserStore {
    fn ensure_init(&self) {
        if self.initialized.get() {
            return;
        }
        let sql = self.state.storage().sql();
        let _ = sql.exec(
            "CREATE TABLE IF NOT EXISTS transactions (
                tx_id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                session_id TEXT,
                method TEXT,
                url TEXT,
                status INTEGER,
                elapsed_ms INTEGER,
                model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_read INTEGER,
                cache_creation INTEGER,
                stop_reason TEXT,
                tools_json TEXT,
                req_body_bytes INTEGER,
                resp_body_bytes INTEGER
            )",
            None,
        );
        let _ = sql.exec(
            "CREATE INDEX IF NOT EXISTS idx_ts ON transactions(ts DESC)",
            None,
        );
        let _ = sql.exec(
            "CREATE INDEX IF NOT EXISTS idx_session ON transactions(session_id, ts)",
            None,
        );
        let _ = sql.exec(
            "CREATE TABLE IF NOT EXISTS session_ends (
                session_id TEXT PRIMARY KEY,
                ended_at INTEGER NOT NULL
            )",
            None,
        );
        // Additive column migrations. SQLite errors if a column already
        // exists; we swallow via `let _` so the call is idempotent.
        let new_cols: &[(&str, &str)] = &[
            ("cache_creation_5m", "INTEGER"),
            ("cache_creation_1h", "INTEGER"),
            ("thinking_budget", "INTEGER"),
            ("thinking_blocks", "INTEGER"),
            ("max_tokens", "INTEGER"),
            ("rl_req_remaining", "INTEGER"),
            ("rl_req_limit", "INTEGER"),
            ("rl_tok_remaining", "INTEGER"),
            ("rl_tok_limit", "INTEGER"),
        ];
        for (name, typ) in new_cols {
            let _ = sql.exec(
                &format!("ALTER TABLE transactions ADD COLUMN {} {}", name, typ),
                None,
            );
        }
        self.initialized.set(true);
    }

    async fn session_ends(&self) -> Result<Response> {
        let sql = self.state.storage().sql();
        let cursor = sql.exec(
            "SELECT session_id, ended_at FROM session_ends",
            None,
        )?;
        let rows: Vec<serde_json::Value> = cursor.to_array()?;
        let mut map = serde_json::Map::new();
        for r in rows {
            let (Some(sid), Some(ended)) = (
                r.get("session_id").and_then(|v| v.as_str()),
                r.get("ended_at").and_then(|v| v.as_i64()),
            ) else {
                continue;
            };
            map.insert(sid.to_string(), json!(ended));
        }
        Response::from_json(&serde_json::Value::Object(map))
    }

    async fn end_session(&self, req: &mut Request) -> Result<Response> {
        #[derive(Deserialize)]
        struct Body {
            session_id: String,
        }
        let b: Body = match req.json().await {
            Ok(b) => b,
            Err(_) => return Response::error("invalid body", 400),
        };
        if b.session_id.is_empty() {
            return Response::error("session_id required", 400);
        }
        let ended_at = Date::now().as_millis() as i64;
        self.state.storage().sql().exec(
            "INSERT OR REPLACE INTO session_ends (session_id, ended_at) VALUES (?, ?)",
            Some(vec![b.session_id.clone().into(), ended_at.into()]),
        )?;
        Response::from_json(&json!({ "session_id": b.session_id, "ended_at": ended_at }))
    }

    async fn ingest(&self, req: &mut Request) -> Result<Response> {
        let r: TransactionRecord = req.json().await?;
        let sql = self.state.storage().sql();
        sql.exec(
            "INSERT OR REPLACE INTO transactions
             (tx_id, ts, session_id, method, url, status, elapsed_ms,
              model, input_tokens, output_tokens, cache_read, cache_creation,
              stop_reason, tools_json, req_body_bytes, resp_body_bytes,
              cache_creation_5m, cache_creation_1h, thinking_budget, thinking_blocks,
              max_tokens, rl_req_remaining, rl_req_limit, rl_tok_remaining, rl_tok_limit)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            Some(vec![
                r.tx_id.into(),
                r.ts.into(),
                r.session_id.into(),
                r.method.into(),
                r.url.into(),
                (r.status as i64).into(),
                r.elapsed_ms.into(),
                r.model.into(),
                r.input_tokens.into(),
                r.output_tokens.into(),
                r.cache_read.into(),
                r.cache_creation.into(),
                r.stop_reason.into(),
                r.tools_json.into(),
                r.req_body_bytes.into(),
                r.resp_body_bytes.into(),
                r.cache_creation_5m.into(),
                r.cache_creation_1h.into(),
                r.thinking_budget.into(),
                r.thinking_blocks.into(),
                r.max_tokens.into(),
                r.rl_req_remaining.into(),
                r.rl_req_limit.into(),
                r.rl_tok_remaining.into(),
                r.rl_tok_limit.into(),
            ]),
        )?;
        Response::ok("ok")
    }

    async fn recent(&self) -> Result<Response> {
        let sql = self.state.storage().sql();
        let cursor = sql.exec(
            "SELECT tx_id, ts, session_id, method, url, model, status, elapsed_ms,
                    input_tokens, output_tokens, cache_read, cache_creation,
                    stop_reason, tools_json, req_body_bytes, resp_body_bytes,
                    cache_creation_5m, cache_creation_1h,
                    thinking_budget, thinking_blocks, max_tokens,
                    rl_req_remaining, rl_req_limit,
                    rl_tok_remaining, rl_tok_limit
             FROM transactions ORDER BY ts DESC",
            None,
        )?;
        let rows: Vec<serde_json::Value> = cursor.to_array()?;
        Response::from_json(&rows)
    }

    async fn stats(&self) -> Result<Response> {
        let sql = self.state.storage().sql();
        let cursor = sql.exec(
            "SELECT
                COUNT(*) AS turns,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read), 0) AS cache_read,
                COALESCE(SUM(cache_creation), 0) AS cache_creation,
                COALESCE(SUM(req_body_bytes), 0) AS req_bytes,
                COALESCE(SUM(resp_body_bytes), 0) AS resp_bytes,
                MIN(ts) AS first_ts,
                MAX(ts) AS last_ts
             FROM transactions",
            None,
        )?;
        let rows: Vec<serde_json::Value> = cursor.to_array()?;
        let mut summary = rows.into_iter().next().unwrap_or(json!({}));
        if let Some(obj) = summary.as_object_mut() {
            obj.insert("storage_bytes".into(), json!(sql.database_size() as i64));
        }
        Response::from_json(&summary)
    }

    // Generic SQL execution endpoint. Powers `burnage shell` and any other
    // admin tooling. Auth is enforced upstream in `admin_route`; this handler
    // trusts that whoever reached it owns this DO (or the proxy operator
    // owns the deployment, single-tenant-by-default).
    async fn sql_exec(&self, req: &mut Request) -> Result<Response> {
        #[derive(Deserialize)]
        struct Body {
            sql: String,
            #[serde(default)]
            params: Vec<serde_json::Value>,
        }
        let body: Body = match req.json().await {
            Ok(b) => b,
            Err(_) => return sql_error_response("invalid body — expected {sql, params?}"),
        };
        if body.sql.trim().is_empty() {
            return sql_error_response("sql cannot be empty");
        }

        let started = Date::now().as_millis() as i64;
        let sql = self.state.storage().sql();

        let params: Option<Vec<SqlStorageValue>> = if body.params.is_empty() {
            None
        } else {
            Some(body.params.iter().map(json_to_sql_value).collect())
        };

        let cursor = match sql.exec(&body.sql, params) {
            Ok(c) => c,
            Err(e) => return sql_error_response(&format!("{e}")),
        };
        let rows: Vec<serde_json::Value> = match cursor.to_array() {
            Ok(r) => r,
            Err(e) => return sql_error_response(&format!("{e}")),
        };

        // Column order from the first row's object keys. SQLite + worker-rs
        // preserve insertion order so this matches SELECT projection.
        let columns: Vec<String> = rows
            .first()
            .and_then(|r| r.as_object())
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();

        // For DML, follow up with `SELECT changes()` so the client gets a
        // useful "affected" count instead of 0.
        let first_kw = body
            .sql
            .trim_start()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        let affected: i64 = if matches!(
            first_kw.as_str(),
            "INSERT" | "UPDATE" | "DELETE" | "REPLACE"
        ) {
            sql.exec("SELECT changes() AS n", None)
                .ok()
                .and_then(|c| c.to_array::<serde_json::Value>().ok())
                .and_then(|rs| rs.into_iter().next())
                .and_then(|r| r.get("n").and_then(|v| v.as_i64()))
                .unwrap_or(0)
        } else {
            rows.len() as i64
        };

        let took_ms = Date::now().as_millis() as i64 - started;
        Response::from_json(&json!({
            "columns": columns,
            "rows": rows,
            "affected": affected,
            "took_ms": took_ms,
        }))
    }
}

fn sql_error_response(msg: &str) -> Result<Response> {
    let r = Response::from_json(&json!({ "error": msg }))?;
    Ok(r.with_status(400))
}

fn json_to_sql_value(v: &serde_json::Value) -> SqlStorageValue {
    match v {
        serde_json::Value::Null => SqlStorageValue::Null,
        serde_json::Value::Bool(b) => SqlStorageValue::Boolean(*b),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(SqlStorageValue::Integer)
            .or_else(|| n.as_f64().map(SqlStorageValue::Float))
            .unwrap_or(SqlStorageValue::Null),
        serde_json::Value::String(s) => SqlStorageValue::String(s.clone()),
        // SQLite has no native array/object — stringify so callers can store
        // JSON blobs in TEXT columns.
        _ => SqlStorageValue::String(v.to_string()),
    }
}

// ---------- Wire types ----------

#[derive(Serialize, Deserialize, Default)]
struct TransactionRecord {
    tx_id: String,
    ts: i64,
    session_id: Option<String>,
    method: String,
    url: String,
    status: i32,
    elapsed_ms: i64,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_creation: i64,
    stop_reason: Option<String>,
    tools_json: Option<String>,
    req_body_bytes: i64,
    resp_body_bytes: i64,
    #[serde(default)]
    cache_creation_5m: Option<i64>,
    #[serde(default)]
    cache_creation_1h: Option<i64>,
    #[serde(default)]
    thinking_budget: Option<i64>,
    #[serde(default)]
    thinking_blocks: Option<i64>,
    #[serde(default)]
    max_tokens: Option<i64>,
    #[serde(default)]
    rl_req_remaining: Option<i64>,
    #[serde(default)]
    rl_req_limit: Option<i64>,
    #[serde(default)]
    rl_tok_remaining: Option<i64>,
    #[serde(default)]
    rl_tok_limit: Option<i64>,
}

// ---------- SSE parsing ----------

#[derive(Default)]
struct SseStats {
    tx_id: Option<String>,
    model: Option<String>,
    input_tokens: i64,
    output_tokens: i64,
    cache_read: i64,
    cache_creation: i64,
    cache_creation_5m: i64,
    cache_creation_1h: i64,
    stop_reason: Option<String>,
    tools: Vec<String>,
    thinking_blocks: i64,
}

fn parse_sse_usage(body: &str) -> SseStats {
    let mut stats = SseStats::default();
    for line in body.lines() {
        let line = line.trim();
        if !line.starts_with("data:") {
            continue;
        }
        let payload = line[5..].trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let evt: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let t = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match t {
            "message_start" => {
                if let Some(m) = evt.get("message") {
                    stats.model = m.get("model").and_then(|v| v.as_str()).map(String::from);
                    stats.tx_id = m.get("id").and_then(|v| v.as_str()).map(String::from);
                    if let Some(u) = m.get("usage") {
                        merge_usage(&mut stats, u);
                    }
                }
            }
            "message_delta" => {
                if let Some(u) = evt.get("usage") {
                    merge_usage(&mut stats, u);
                }
                if let Some(d) = evt.get("delta") {
                    if let Some(s) = d.get("stop_reason").and_then(|v| v.as_str()) {
                        stats.stop_reason = Some(s.to_string());
                    }
                }
            }
            "content_block_start" => {
                if let Some(cb) = evt.get("content_block") {
                    match cb.get("type").and_then(|v| v.as_str()) {
                        Some("tool_use") => {
                            if let Some(n) = cb.get("name").and_then(|v| v.as_str()) {
                                stats.tools.push(n.to_string());
                            }
                        }
                        Some("thinking") => {
                            stats.thinking_blocks += 1;
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    stats
}

fn merge_usage(s: &mut SseStats, u: &serde_json::Value) {
    if let Some(v) = u.get("input_tokens").and_then(|v| v.as_i64()) {
        s.input_tokens = v;
    }
    if let Some(v) = u.get("output_tokens").and_then(|v| v.as_i64()) {
        s.output_tokens = v;
    }
    if let Some(v) = u.get("cache_read_input_tokens").and_then(|v| v.as_i64()) {
        s.cache_read = v;
    }
    if let Some(v) = u.get("cache_creation_input_tokens").and_then(|v| v.as_i64()) {
        s.cache_creation = v;
    }
    // Granular cache TTL split — present on newer API responses only.
    if let Some(cc) = u.get("cache_creation").and_then(|v| v.as_object()) {
        if let Some(v) = cc.get("ephemeral_5m_input_tokens").and_then(|v| v.as_i64()) {
            s.cache_creation_5m = v;
        }
        if let Some(v) = cc.get("ephemeral_1h_input_tokens").and_then(|v| v.as_i64()) {
            s.cache_creation_1h = v;
        }
    }
}

// Parse the inbound request body (not required — errors return defaults).
// Returns (max_tokens, thinking_budget).
fn parse_request_body(bytes: &[u8]) -> (Option<i64>, Option<i64>) {
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return (None, None),
    };
    let max_tokens = v.get("max_tokens").and_then(|x| x.as_i64());
    let thinking_budget = v
        .get("thinking")
        .and_then(|t| t.as_object())
        .filter(|o| o.get("type").and_then(|x| x.as_str()) == Some("enabled"))
        .and_then(|o| o.get("budget_tokens").and_then(|x| x.as_i64()));
    (max_tokens, thinking_budget)
}

// Anthropic rate-limit headers come back as plain integers in decimal.
// We read the few that matter and ignore the reset timestamps for now.
fn parse_rate_limits(
    headers: &[(String, String)],
) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
    let g = |name: &str| -> Option<i64> { header_value(headers, name)?.parse::<i64>().ok() };
    (
        g("anthropic-ratelimit-requests-remaining"),
        g("anthropic-ratelimit-requests-limit"),
        g("anthropic-ratelimit-input-tokens-remaining")
            .or_else(|| g("anthropic-ratelimit-tokens-remaining")),
        g("anthropic-ratelimit-input-tokens-limit")
            .or_else(|| g("anthropic-ratelimit-tokens-limit")),
    )
}

// ---------- Identity ----------

fn header_value(entries: &[(String, String)], name: &str) -> Option<String> {
    entries
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
}

// Resolve the caller's stable user_hash.
//
// OAuth bearers rotate every few hours, so hashing the raw token produces a
// new user_hash on every refresh. Instead we resolve the bearer to Anthropic's
// `account.uuid` (immutable per-account) via the /api/oauth/profile endpoint,
// cache the token → uuid/email mapping in KV (1h TTL, matches the bearer's own
// lifetime), and hash the uuid. Result: user_hash is stable across refreshes,
// devices, and sessions.
//
// Side-effect: resolving the profile also writes `link:<email> = user_hash`
// so the dashboard (CF-Access-authenticated by the same email) auto-scopes
// without any manual setup step.
//
// API keys hash directly — they're already stable identifiers.
async fn compute_user_hash(
    entries: &[(String, String)],
    salt: &str,
    env: &Env,
) -> Option<(String, Option<String>)> {
    if let Some(raw_auth) = header_value(entries, "authorization") {
        let token = raw_auth
            .strip_prefix("Bearer ")
            .unwrap_or(&raw_auth)
            .to_string();
        return Some(resolve_oauth_hash(&token, salt, env).await);
    }
    if let Some(api_key) = header_value(entries, "x-api-key") {
        return Some((hash_identity(salt, "apikey:", &api_key), None));
    }
    None
}

fn hash_identity(salt: &str, prefix: &str, id: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt.as_bytes());
    h.update(prefix.as_bytes());
    h.update(id.as_bytes());
    hex::encode(&h.finalize()[..8])
}

async fn resolve_oauth_hash(token: &str, salt: &str, env: &Env) -> (String, Option<String>) {
    // token_id identifies "this bearer value" without exposing the bearer in
    // KV keys. Salted so different deployments never share KV state.
    let token_id = hash_identity(salt, "tok:", token);
    let cache_key = format!("tok:{}", token_id);

    // KV hit: {uuid}|{email}. One round-trip to KV, skip the profile fetch.
    if let Ok(kv) = env.kv("SESSION") {
        if let Ok(Some(cached)) = kv.get(&cache_key).text().await {
            if let Some((uuid, email)) = cached.split_once('|') {
                let hash = hash_identity(salt, "uuid:", uuid);
                auto_link(&kv, email, &hash).await;
                return (hash, Some(email.to_string()));
            }
        }

        // KV miss: fetch profile, cache, hash.
        if let Some((uuid, email)) = fetch_anthropic_profile(token).await {
            let value = format!("{}|{}", uuid, email);
            if let Ok(builder) = kv.put(&cache_key, value) {
                let _ = builder.expiration_ttl(3600).execute().await;
            }
            let hash = hash_identity(salt, "uuid:", &uuid);
            auto_link(&kv, &email, &hash).await;
            return (hash, Some(email));
        }
    }

    // Degraded fallback — raw-token hash. Prefix keeps it in a disjoint
    // namespace from uuid hashes so a future successful resolve rejoins the
    // stable identity cleanly. Rare: only fires on KV outages or profile
    // endpoint failures.
    console_log!(
        "{{\"dir\":\"hash_fallback\",\"reason\":\"profile_or_kv_unavailable\"}}"
    );
    (hash_identity(salt, "raw:", token), None)
}

async fn fetch_anthropic_profile(token: &str) -> Option<(String, String)> {
    let headers = Headers::new();
    headers
        .append("authorization", &format!("Bearer {}", token))
        .ok()?;
    headers.append("anthropic-beta", "oauth-2025-04-20").ok();
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    init.with_headers(headers);
    let req = Request::new_with_init(
        "https://api.anthropic.com/api/oauth/profile",
        &init,
    )
    .ok()?;
    let mut resp = Fetch::Request(req).send().await.ok()?;
    if resp.status_code() != 200 {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let uuid = v.pointer("/account/uuid").and_then(|x| x.as_str())?;
    let email = v.pointer("/account/email").and_then(|x| x.as_str())?;
    Some((uuid.to_string(), email.trim().to_lowercase()))
}

async fn auto_link(kv: &KvStore, email: &str, hash: &str) {
    let email_norm = email.trim().to_lowercase();
    if email_norm.is_empty() {
        return;
    }
    let key = format!("link:{}", email_norm);
    // Skip the write if the link already points at this hash. KV writes are
    // cheap but visible in metrics; idempotence is free.
    if let Ok(Some(existing)) = kv.get(&key).text().await {
        if existing == hash {
            return;
        }
    }
    if let Ok(builder) = kv.put(&key, hash) {
        let _ = builder.execute().await;
    }
}
