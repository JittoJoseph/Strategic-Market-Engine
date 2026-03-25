import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Returns "text-emerald-500" or "text-red-500" based on sign. Optional opacity suffix e.g. "/70". */
export function pnlColor(value: number, opacity?: string): string {
  const base = value >= 0 ? "text-emerald-500" : "text-red-500";
  return opacity ? `${base}/${opacity}` : base;
}

/** Format a PnL value as "+$0.0123" or "-$0.0456". */
export function formatPnl(value: number, decimals = 4): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(decimals)}`;
}
