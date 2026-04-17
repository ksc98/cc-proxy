import * as React from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DataTableColumnHeader,
  DataTableFacetedFilter,
  DataTableToolbar,
  type FacetOption,
} from "@/components/ui/data-table";
import type { TransactionRow } from "@/lib/store";
import { shortToolName } from "@/lib/tools";
import { cn } from "@/lib/cn";
import { subscribeRows } from "@/lib/rowsBus";
import { TurnDetail } from "@/components/TurnDetail";
import {
  CacheReadCell,
  CacheWrite1hCell,
  CacheWrite5mCell,
  COLUMN_LABELS,
  CostCell,
  DurationCell,
  InTokensCell,
  ModelCell,
  OutTokensCell,
  RIGHT_ALIGNED_COLS,
  shortModel,
  StopDot,
  ToolsCell,
  txAccessors,
  WhenCell,
} from "@/components/table-cells";

type TurnRow = {
  tx: TransactionRow;
  /** 1-based turn position within this session. */
  index: number;
};

function toTurns(rows: TransactionRow[], sessionId: string): TurnRow[] {
  return rows
    .filter((r) => r.session_id === sessionId)
    // Filter out auxiliary requests (e.g. count_tokens) — zero tokens, zero cost.
    .filter((r) => r.model || r.in_flight === 1)
    .sort((a, b) => a.ts - b.ts)
    .map((tx, i) => ({ tx, index: i + 1 }));
}

/** Filter fn: row.getValue(id) is the space-separated tool string from txAccessors.tools. */
function toolsFilterFn(
  row: { getValue: (id: string) => unknown },
  id: string,
  value: string[],
): boolean {
  if (!Array.isArray(value) || value.length === 0) return true;
  const hay = String(row.getValue(id) ?? "").split(" ").filter(Boolean);
  return value.some((f) => hay.includes(f));
}

const columns: ColumnDef<TurnRow>[] = [
  {
    id: "expand",
    header: () => null,
    enableSorting: false,
    enableHiding: false,
    cell: () => null,
  },
  {
    accessorFn: (r) => r.index,
    id: "turn",
    header: ({ column }) => <DataTableColumnHeader column={column} title="#" />,
    sortingFn: "basic",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-[var(--color-subtle-foreground)] tabular-nums">
        {row.original.index}
      </span>
    ),
  },
  {
    id: "dot",
    header: () => null,
    enableSorting: false,
    enableHiding: false,
    accessorFn: (r) => txAccessors.stop(r.tx),
    filterFn: "arrIncludesSome",
    cell: ({ row }) => <StopDot tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.when(r.tx),
    id: "when",
    header: ({ column }) => <DataTableColumnHeader column={column} title="When" />,
    sortingFn: "basic",
    cell: ({ row }) => <WhenCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.duration(r.tx),
    id: "duration",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Duration" align="right" />
    ),
    cell: ({ row }) => <DurationCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.model(r.tx),
    id: "model",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Model" />,
    filterFn: "arrIncludesSome",
    cell: ({ row }) => <ModelCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.in(r.tx),
    id: "in",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="In" align="right" />
    ),
    cell: ({ row }) => <InTokensCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.out(r.tx),
    id: "out",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Out" align="right" />
    ),
    cell: ({ row }) => <OutTokensCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.cache_read(r.tx),
    id: "cache_read",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Cache R" align="right" />
    ),
    cell: ({ row }) => <CacheReadCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.cache_5m(r.tx),
    id: "cache_5m",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="CW 5m" align="right" />
    ),
    cell: ({ row }) => <CacheWrite5mCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.cache_1h(r.tx),
    id: "cache_1h",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="CW 1h" align="right" />
    ),
    cell: ({ row }) => <CacheWrite1hCell tx={row.original.tx} />,
  },
  {
    id: "tools",
    header: "Tools",
    enableSorting: false,
    accessorFn: (r) => txAccessors.tools(r.tx),
    filterFn: toolsFilterFn,
    cell: ({ row }) => <ToolsCell tx={row.original.tx} />,
  },
  {
    accessorFn: (r) => txAccessors.cost(r.tx),
    id: "cost",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Cost" align="right" />
    ),
    cell: ({ row }) => <CostCell tx={row.original.tx} />,
  },
];

export default function SessionTurnsTable({
  initialRows,
  sessionId,
}: {
  initialRows: TransactionRow[];
  sessionId: string;
}) {
  const [rows, setRows] = React.useState<TransactionRow[]>(initialRows);
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "turn", desc: true },
  ]);
  const [globalFilter, setGlobalFilter] = React.useState("");
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>(
    [],
  );
  const [columnVisibility, setColumnVisibility] =
    React.useState<VisibilityState>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [highlightTxId, setHighlightTxId] = React.useState<string | null>(null);

  React.useEffect(() => subscribeRows(setRows), []);

  const data = React.useMemo(
    () => toTurns(rows, sessionId),
    [rows, sessionId],
  );

  // Pre-compute faceted option lists so they reflect the full dataset (not just
  // the currently-filtered slice) and give stable ordering.
  const modelOptions = React.useMemo<FacetOption[]>(() => {
    const counts = new Map<string, number>();
    for (const r of data) {
      const m = r.tx.model;
      if (!m) continue;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([m, n]) => ({ value: m, label: shortModel(m), count: n }));
  }, [data]);

  const stopOptions = React.useMemo<FacetOption[]>(() => {
    const counts = new Map<string, number>();
    for (const r of data) {
      const key = txAccessors.stop(r.tx);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => ({ value: s, label: s, count: n }));
  }, [data]);

  const toolOptions = React.useMemo<FacetOption[]>(() => {
    const counts = new Map<string, number>();
    for (const r of data) {
      const arr: string[] = r.tx.tools_json ? JSON.parse(r.tx.tools_json) : [];
      for (const t of arr.map(shortToolName)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([t, n]) => ({ value: t, label: t, count: n }));
  }, [data]);

  // Deep-link handling: if the URL fragment is #<tx_id> (set by command palette
  // result links), auto-expand that turn, scroll it into view, and flash a
  // highlight so it's obvious which row matched. Re-runs when `data` grows
  // in case the row arrives via polling after first paint, but a ref guard
  // prevents re-scrolling the user away on every subsequent row update.
  const handledHashRef = React.useRef<string | null>(null);
  const highlightTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const apply = () => {
      const raw = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
      if (!raw) return;
      const txId = decodeURIComponent(raw);
      if (handledHashRef.current === txId) return;
      if (!data.some((d) => d.tx.tx_id === txId)) return;
      handledHashRef.current = txId;
      setExpanded((p) => ({ ...p, [txId]: true }));
      setHighlightTxId(txId);
      requestAnimationFrame(() => {
        document
          .getElementById(`row-${txId}`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
      if (highlightTimerRef.current != null) {
        window.clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = window.setTimeout(() => {
        setHighlightTxId(null);
        highlightTimerRef.current = null;
      }, 2800);
    };
    apply();
    const onHash = () => {
      handledHashRef.current = null;
      apply();
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      if (highlightTimerRef.current != null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, [data]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, columnFilters, columnVisibility },
    getRowId: (r) => r.tx.tx_id,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _id, value) => {
      const q = String(value).toLowerCase().trim();
      if (!q) return true;
      const tx = row.original.tx;
      const hay = [
        tx.model ?? "",
        tx.stop_reason ?? "",
        tx.tools_json ?? "",
        tx.url ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    },
  });

  const visibleColCount = table.getVisibleLeafColumns().length;

  return (
    <section className="card overflow-hidden">
      <DataTableToolbar
        table={table}
        searchValue={globalFilter}
        onSearchChange={setGlobalFilter}
        placeholder="Filter model, tool, url…"
        columnLabels={COLUMN_LABELS}
        leading={
          <>
            <h2 className="text-sm font-medium">Turns</h2>
            <span className="text-xs text-[var(--color-subtle-foreground)] tabular-nums">
              {data.length} {data.length === 1 ? "turn" : "turns"}
            </span>
          </>
        }
        filters={
          <>
            {modelOptions.length > 1 && (
              <DataTableFacetedFilter
                column={table.getColumn("model")}
                title="Model"
                options={modelOptions}
              />
            )}
            {stopOptions.length > 1 && (
              <DataTableFacetedFilter
                column={table.getColumn("dot")}
                title="Status"
                options={stopOptions}
              />
            )}
            {toolOptions.length > 0 && (
              <DataTableFacetedFilter
                column={table.getColumn("tools")}
                title="Tools"
                options={toolOptions}
                width="w-[16rem]"
              />
            )}
          </>
        }
      />

      {data.length === 0 ? (
        <p className="px-5 py-10 text-[var(--color-muted-foreground)] text-sm text-center">
          No turns yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="border-t-0 hover:bg-transparent">
                {hg.headers.map((h) => {
                  const isRight = RIGHT_ALIGNED_COLS.has(h.id);
                  return (
                    <TableHead
                      key={h.id}
                      className={cn(
                        h.id === "expand" && "w-4 pl-4 pr-1",
                        h.id === "turn" && "w-10",
                        h.id === "dot" && "w-3 px-2",
                        h.id === "when" && "w-16",
                        h.id === "duration" && "w-16",
                        isRight && "text-right",
                      )}
                    >
                      {h.isPlaceholder
                        ? null
                        : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const tx = row.original.tx;
              const isOpen = !!expanded[tx.tx_id];
              return (
                <React.Fragment key={row.id}>
                  <TableRow
                    id={`row-${tx.tx_id}`}
                    className={cn(
                      "cursor-pointer scroll-mt-24 transition-colors duration-700",
                      highlightTxId === tx.tx_id &&
                        "bg-amber-400/10 outline outline-2 -outline-offset-2 outline-amber-400/60",
                    )}
                    onClick={() =>
                      setExpanded((p) => ({ ...p, [tx.tx_id]: !p[tx.tx_id] }))
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          cell.column.id === "expand" && "pl-4 pr-1 w-4 align-middle",
                          cell.column.id === "turn" && "w-10",
                          cell.column.id === "dot" && "px-2 w-3",
                          cell.column.id === "when" && "w-14",
                        )}
                      >
                        {cell.column.id === "expand" ? (
                          isOpen ? (
                            <ChevronDown
                              size={14}
                              className="text-[var(--color-subtle-foreground)]"
                            />
                          ) : (
                            <ChevronRight
                              size={14}
                              className="text-[var(--color-subtle-foreground)]"
                            />
                          )
                        ) : (
                          flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell
                        colSpan={visibleColCount}
                        className="bg-[var(--color-background)]/40 px-6 py-4"
                      >
                        <TurnDetail tx={tx} />
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
            {table.getRowModel().rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={visibleColCount}
                  className="py-10 text-center text-xs text-[var(--color-muted-foreground)]"
                >
                  No turns match the current filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
