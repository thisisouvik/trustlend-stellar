import { clsx } from "clsx";
import { type HTMLAttributes, type TableHTMLAttributes, type ThHTMLAttributes, type TdHTMLAttributes } from "react";

export function TableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("overflow-x-auto rounded-2xl border border-slate-200", className)} {...props} />;
}

export function Table({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={clsx("w-full min-w-[620px] border-collapse", className)} {...props} />;
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={clsx("bg-slate-50", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={clsx(className)} {...props} />;
}

export function TableTh({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={clsx("px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-500", className)} {...props} />;
}

export function TableTd({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={clsx("border-t border-slate-100 px-4 py-3 text-sm text-slate-700", className)} {...props} />;
}
