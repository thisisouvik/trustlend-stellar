import { clsx } from "clsx";

interface ProgressProps {
  value: number;
  className?: string;
}

export function Progress({ value, className }: ProgressProps) {
  const bounded = Math.max(0, Math.min(100, value));

  return (
    <div className={clsx("h-2 w-full overflow-hidden rounded-full bg-slate-200", className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-violet-600 to-emerald-400 transition-all"
        style={{ width: `${bounded}%` }}
      />
    </div>
  );
}
