import * as React from "react";
import { type Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/cn";

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
  align = "left",
}: {
  column: Column<TData, TValue>;
  title: React.ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  if (!column.getCanSort()) {
    return (
      <span
        className={cn(
          "inline-flex items-center",
          align === "right" && "w-full justify-end",
          className,
        )}
      >
        {title}
      </span>
    );
  }
  const dir = column.getIsSorted();
  return (
    <button
      type="button"
      onClick={() => column.toggleSorting(dir === "asc")}
      className={cn(
        "group inline-flex items-center gap-1 select-none cursor-pointer",
        "hover:text-[var(--color-foreground)] transition-colors",
        align === "right" && "w-full justify-end",
        className,
      )}
    >
      <span>{title}</span>
      {dir === "asc" ? (
        <ArrowUp size={11} className="text-[var(--color-foreground)]" />
      ) : dir === "desc" ? (
        <ArrowDown size={11} className="text-[var(--color-foreground)]" />
      ) : (
        <ChevronsUpDown
          size={11}
          className="opacity-40 group-hover:opacity-80 transition-opacity"
        />
      )}
    </button>
  );
}
