"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Check, Coins, Landmark, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { StellarSignInButton } from "@/components/auth/StellarSignInButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/components/ui/cn";
import { EASE_OUT } from "@/lib/motion";

type AuthSelectableRole = "borrower" | "lender";

const ROLE_META: Record<AuthSelectableRole, { label: string; icon: LucideIcon; tagline: string; points: string[] }> = {
  borrower: {
    label: "Borrower",
    icon: Coins,
    tagline: "Access micro-loans built on your real financial behavior.",
    points: ["Behavior-based trust score", "No collateral required", "Repay early, pay less interest"],
  },
  lender: {
    label: "Lender",
    icon: Landmark,
    tagline: "Earn transparent returns by funding verified borrowers.",
    points: ["Fund loans directly or via pools", "Every borrower has an on-chain score", "Repayments settle to your wallet"],
  },
};

const DEFAULT_POINTS = [
  "Sign in by signing a challenge — no passwords",
  "Non-custodial: your keys never leave your wallet",
  "Varial, xBull, Albedo and WalletConnect supported",
];

export function AuthPageClient() {
  const [role, setRole] = useState<AuthSelectableRole | null>(null);
  const meta = role ? ROLE_META[role] : null;

  return (
    <main className="grid min-h-screen bg-bg text-fg lg:grid-cols-[1.05fr_1fr]">
      {/* Left — brand panel */}
      <aside className="relative hidden overflow-hidden bg-[image:var(--gradient-primary)] p-10 text-white lg:flex lg:flex-col lg:justify-between" aria-hidden="true">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 top-1/3 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute -right-10 bottom-10 h-96 w-96 rounded-full bg-accent/30 blur-3xl" />
        </div>

        <Link href="/" className="relative flex items-center gap-2.5">
          <Image src="/logo.png" alt="" width={36} height={36} className="h-9 w-9 rounded-xl object-cover" />
          <span className="font-display text-lg font-bold tracking-tight">TrustLend</span>
        </Link>

        <div className="relative max-w-md">
          <motion.div
            key={role ?? "none"}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs font-semibold backdrop-blur">
              {meta ? <meta.icon className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
              {meta ? `Joining as ${meta.label}` : "Welcome to TrustLend"}
            </span>
            <h2 className="mt-5 font-display text-3xl font-bold leading-tight tracking-tight xl:text-4xl">
              {meta ? meta.tagline : "Credit built on behavior, not collateral."}
            </h2>
            <ul className="mt-6 space-y-3 text-sm text-white/85">
              {(meta ? meta.points : DEFAULT_POINTS).map((p) => (
                <li key={p} className="flex items-center gap-3">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/15">
                    <Check className="h-3 w-3" />
                  </span>
                  {p}
                </li>
              ))}
            </ul>
          </motion.div>
        </div>

        <p className="relative flex items-center gap-2 text-xs text-white/70">
          <ShieldCheck className="h-4 w-4" /> Sign-In with Stellar (SEP-10) · Stellar testnet
        </p>
      </aside>

      {/* Right — sign-in */}
      <section className="flex flex-col px-6 py-8 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Back to home
          </Link>
          <ThemeToggle />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE_OUT }}
          className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10"
        >
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <Image src="/logo.png" alt="" width={32} height={32} className="h-8 w-8 rounded-lg object-cover" />
            <span className="font-display text-lg font-bold tracking-tight">TrustLend</span>
          </div>

          <h1 className="font-display text-3xl font-bold tracking-tight">Connect your wallet</h1>
          <p className="mt-2 text-sm text-fg-muted">Choose your role, then sign in with your Stellar wallet.</p>

          <div className="mt-8" role="group" aria-label="Choose your role">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">I am a</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {(["borrower", "lender"] as AuthSelectableRole[]).map((r) => {
                const Icon = ROLE_META[r].icon;
                const active = role === r;
                return (
                  <button
                    key={r}
                    type="button"
                    id={`role-tab-${r}`}
                    onClick={() => setRole(r)}
                    aria-pressed={active}
                    className={cn(
                      "flex flex-col items-start gap-3 rounded-card border p-4 text-left transition-[border-color,box-shadow,background-color]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary-soft/60 shadow-glow"
                        : "border-border bg-surface hover:border-border-strong hover:bg-surface-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-9 w-9 place-items-center rounded-lg",
                        active ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg-muted",
                      )}
                    >
                      <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                    </span>
                    <span>
                      <span className="block font-display text-sm font-semibold text-fg">{ROLE_META[r].label}</span>
                      <span className="mt-0.5 block text-xs text-fg-muted">
                        {r === "borrower" ? "I want to borrow" : "I want to lend"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-8">
            <StellarSignInButton className="w-full" disabled={!role} role={role ?? undefined} />
          </div>

          <p className="mt-4 text-center text-xs text-fg-subtle">
            {role
              ? "Existing accounts keep their current role; the choice above only applies to new wallets."
              : "Select a role to continue."}
          </p>

          <p className="mt-10 text-center text-xs text-fg-subtle">
            By continuing you agree to TrustLend&apos;s{" "}
            <a href="#" className="font-medium text-fg-muted underline-offset-2 hover:underline">
              Terms
            </a>{" "}
            and{" "}
            <a href="#" className="font-medium text-fg-muted underline-offset-2 hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </motion.div>
      </section>
    </main>
  );
}
