"use client";

/**
 * Persists a `?ref=CODE` arriving on /auth so it survives the wallet sign-in
 * round trip (Issue #266). The actual, transactional attribution happens
 * later from the dashboard, once the user has a session.
 *
 * Renders nothing.
 */

import { useEffect } from "react";
import { stashReferralCodeFromUrl } from "@/components/dashboard/ReferralCapture";

export function ReferralCodeStash() {
  useEffect(() => {
    stashReferralCodeFromUrl();
  }, []);

  return null;
}
