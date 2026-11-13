import { NextRequest, NextResponse } from "next/server";
import { buildChallenge, SiwsError } from "@/lib/auth/siws-server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { isValidStellarAddress } from "@/lib/http/request-validation";

/**
 * POST /api/auth/siws/challenge
 *
 * Step 1 of Sign-In with Stellar (SEP-0010). Given a wallet address, returns a
 * server-signed challenge transaction for the wallet to sign with Varial.
 *
 * Body: { address: "G..." }
 * 200:  { transaction, networkPassphrase }
 */
export async function POST(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  try {
    const { address } = (await request.json()) as { address?: string };
    if (!isValidStellarAddress(address)) {
      return NextResponse.json({ error: "A valid Stellar address is required" }, { status: 400 });
    }

    const { transaction, networkPassphrase } = buildChallenge(address);
    return NextResponse.json({ transaction, networkPassphrase });
  } catch (err) {
    if (err instanceof SiwsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[siws/challenge]", msg);
    return NextResponse.json({ error: "Failed to create challenge" }, { status: 500 });
  }
}
