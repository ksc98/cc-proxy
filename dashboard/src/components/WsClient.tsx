import { useEffect } from "react";
import type { TransactionRow } from "@/lib/store";
import { publishRows, latestRows } from "@/lib/rowsBus";
import { parseWindow, windowSince } from "@/lib/pillWindow";

type WsEvent =
  | { type: "turn_start"; data: Partial<TransactionRow> }
  | { type: "turn_complete"; data: TransactionRow }
  | { type: "session_end"; data: { session_id: string; ended_at: number } };

const STALE_MS = 5 * 60_000; // 5 min client-side timeout for virtual rows

export default function WsClient({
  sessionId,
  endpoint = "/api/recent",
}: {
  sessionId?: string;
  endpoint?: string;
}) {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let retryMs = 1000;
    const MAX_RETRY = 30_000;

    // Virtual in-flight rows — client-side only, never written to DB.
    const inFlight = new Map<string, TransactionRow>();

    function connect() {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/api/ws`);

      ws.onopen = () => {
        retryMs = 1000;
      };

      ws.onmessage = (ev) => {
        try {
          const msg: WsEvent = JSON.parse(ev.data);
          handleEvent(msg);
        } catch {
          /* malformed message */
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        const jitter = Math.random() * 500;
        setTimeout(connect, retryMs + jitter);
        retryMs = Math.min(retryMs * 2, MAX_RETRY);
      };

      ws.onerror = () => {
        // onclose fires after onerror; reconnect handled there.
      };
    }

    function handleEvent(msg: WsEvent) {
      // Session-scoped mode: ignore events for other sessions.
      if (sessionId && msg.type !== "session_end") {
        const sid =
          msg.type === "turn_start"
            ? msg.data.session_id
            : msg.data.session_id;
        if (sid && sid !== sessionId) return;
      }

      switch (msg.type) {
        case "turn_start": {
          const virtual: TransactionRow = {
            tx_id: msg.data.tx_id ?? "",
            ts: msg.data.ts ?? Date.now(),
            session_id: msg.data.session_id ?? null,
            model: msg.data.model ?? null,
            method: null,
            url: null,
            status: 0,
            elapsed_ms: 0,
            input_tokens: 0,
            output_tokens: 0,
            cache_read: 0,
            cache_creation: 0,
            stop_reason: null,
            req_body_bytes: 0,
            resp_body_bytes: 0,
            in_flight: 1,
            thinking_budget: msg.data.thinking_budget,
            thinking_blocks: null,
            max_tokens: msg.data.max_tokens,
            tools_json: msg.data.tools_json ?? null,
            cache_creation_5m: null,
            cache_creation_1h: null,
            rl_req_remaining: null,
            rl_req_limit: null,
            rl_tok_remaining: null,
            rl_tok_limit: null,
            anthropic_message_id: null,
          };
          inFlight.set(virtual.tx_id, virtual);
          mergeAndPublish();
          break;
        }

        case "turn_complete": {
          inFlight.delete(msg.data.tx_id);
          // Merge the completed row into the current rows.
          const current = latestRows() ?? [];
          const updated = [
            msg.data,
            ...current.filter((r) => r.tx_id !== msg.data.tx_id),
          ];
          // Re-add any remaining in-flight virtuals.
          const virtualArr = [...inFlight.values()];
          const virtualIds = new Set(virtualArr.map((r) => r.tx_id));
          const withoutVirtuals = updated.filter(
            (r) => !virtualIds.has(r.tx_id),
          );
          publishRows([...virtualArr, ...withoutVirtuals]);

          window.dispatchEvent(
            new CustomEvent("cm:turn-complete", { detail: msg.data }),
          );
          break;
        }

        case "session_end": {
          window.dispatchEvent(
            new CustomEvent("cm:session-end", { detail: msg.data }),
          );
          break;
        }
      }
    }

    function mergeAndPublish() {
      const current = latestRows() ?? [];
      const virtualArr = [...inFlight.values()];
      const virtualIds = new Set(virtualArr.map((r) => r.tx_id));
      const filtered = current.filter((r) => !virtualIds.has(r.tx_id));
      publishRows([...virtualArr, ...filtered]);
    }

    // Clean stale virtual rows that never got a turn_complete.
    const staleTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, row] of inFlight) {
        if (now - row.ts > STALE_MS) {
          inFlight.delete(id);
          changed = true;
        }
      }
      if (changed) mergeAndPublish();
    }, 30_000);

    async function fetchFullState() {
      try {
        let url = endpoint;
        // For the overview page, respect the pill window on reconnect.
        if (!sessionId && typeof window !== "undefined") {
          const win = parseWindow(new URL(window.location.href).searchParams);
          const since = windowSince(win);
          const sep = endpoint.includes("?") ? "&" : "?";
          url = `${endpoint}${sep}since=${since}`;
        }
        const res = await fetch(url, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (res.ok) {
          const rows = (await res.json()) as TransactionRow[];
          // Keep any active in-flight virtuals.
          const virtualArr = [...inFlight.values()];
          const virtualIds = new Set(virtualArr.map((r) => r.tx_id));
          publishRows([
            ...virtualArr,
            ...rows.filter((r) => !virtualIds.has(r.tx_id)),
          ]);
        }
      } catch {
        /* next reconnect will retry */
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        ws?.close();
      } else {
        connect();
        fetchFullState();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    connect();

    return () => {
      disposed = true;
      ws?.close();
      window.clearInterval(staleTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, endpoint]);

  return null;
}
