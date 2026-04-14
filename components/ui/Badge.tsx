import { type ReactNode } from "react";
import { clsx } from "clsx";

interface BadgeProps {
  children: ReactNode;
  variant?: "green" | "gold" | "blue";
  className?: string;
}

const variantMap = {
  green: "badge",
  gold: "badge" + " !text-amber-400 !border-amber-400/30 !bg-amber-400/10",
  blue: "badge" + " !text-sky-400 !border-sky-400/30 !bg-sky-400/10",
};

export function Badge({ children, variant = "green", className }: BadgeProps) {
  return (
    <span className={clsx(variantMap[variant], className)}>{children}</span>
  );
}
