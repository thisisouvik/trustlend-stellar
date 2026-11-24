"use client";

/**
 * ReferralCapture — turns a `?ref=CODE` visit into an attributed referral
 * (Issue #266).
 *
 * Auth here is wallet-based (SIWS), so a user arriving on an invite link does
 * not sign up in one step: they land on /auth, connect a wallet, sign, and only
 * then have a session. The code therefore has to survive that round trip.
 *
 * Flow:
 *   1. Any page load with `?ref=CODE` stores the code in sessionStorage.
 *   2. Once mounted inside the authenticated dashboard, we POST it to
 *      /api/referrals/claim and clear the stored value.
 *
 * sessionStorage (not localStorage) is deliberate: the code should not outlive
 * the browsing session and silently attribute a much later, unrelated signup.
 *
 * Renders nothing. Every failure is silent — a referral that cannot be
 * attributed must never interrupt a user who is trying to use the app.
 */

import { useEffect } from "react";
import { normalizeReferralCode, REFERRAL_CLAIM_STORAGE_KEY } from "@/lib/referrals/codes";

/** Read `?ref=` from the current URL and remember it for after sign-in. */
export function stashReferralCodeFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const code = normalizeReferralCode(
      new URLSearchParams(window.location.search).get("ref"),
    );
    if (code) {
      window.sessionStorage.setItem(REFERRAL_CLAIM_STORAGE_KEY, code);
    }
  } catch {
    // Private-mode browsers can throw on storage access; a lost referral is
    // strictly better than a broken page.
  }
}

interface ReferralCaptureProps {
  /**
   * Whether the current visitor already has an attributed referrer. When true
   * we skip the network call entirely — the server would reject it anyway.
   */
  alreadyReferred?: boolean;
}

export function ReferralCapture({ alreadyReferred = false }: ReferralCaptureProps) {
  useEffect(() => {
    // Catch a code on this very page load (e.g. /auth?ref=… before sign-in).
    stashReferralCodeFromUrl();

    if (alreadyReferred) return;

    let cancelled = false;

    const claim = async () => {
      let code: string | null = null;
      try {
        code = window.sessionStorage.getItem(REFERRAL_CLAIM_STORAGE_KEY);
      } catch {
        return;
      }
      if (!code) return;

      try {
        const res = await fetch("/api/referrals/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });

        // Clear on success, and on the terminal failures too — a bad or
        // self-referring code will never succeed on a retry, so keeping it
        // would mean re-POSTing it on every dashboard visit.
        if (res.ok || res.status === 404 || res.status === 409 || res.status === 400) {
          if (!cancelled) {
            try {
              window.sessionStorage.removeItem(REFERRAL_CLAIM_STORAGE_KEY);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        // Network error — leave the code stored so the next visit retries.
      }
    };

    void claim();
    return () => {
      cancelled = true;
    };
  }, [alreadyReferred]);

  return null;
}
