import { clsx } from "clsx";
import { type ButtonHTMLAttributes } from "react";

type Variant = "default" | "outline" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const variantStyles: Record<Variant, string> = {
  default: "bg-violet-600 text-white hover:bg-violet-700",
  outline: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100",
};

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={clsx(
        "inline-flex min-h-9 items-center justify-center rounded-full px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        variantStyles[variant],
        className,
      )}
      {...props}
    />
  );
}
