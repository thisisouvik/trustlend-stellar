import { NextRequest, NextResponse } from "next/server";
import {
  issueSessionForWallet,
  SiwsError,
  verifyChallenge,
} from "@/lib/auth/siws-server";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  signSessionToken,
} from "@/lib/auth/session-token";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { isBoundedString, isValidStellarAddress } from "@/lib/http/request-validation";

/**
 * POST /api/auth/siws/verify
 *
 * Steps 4-5 of Sign-In with Stellar (SEP-0010). Validates the wallet-signed
 * challenge (structure, expiry, signature) and — on success — provisions the
 * wallet's account and sets the HttpOnly session cookie.
 *
 * Body: { address: "G...", signedTxXdr: "<base64 XDR>", role?: "borrower" | "lender" }
 * 200:  { userId, role, isNewUser }   (+ Set-Cookie: tl_session)
 * 4xx:  { error, code }   (invalid_address | invalid_challenge | expired_challenge
 *                          | invalid_signature | address_mismatch | ...)
 */
export async function POST(request: NextRequest) {
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  try {
    const { address, signedTxXdr, role } = (await request.json()) as {
      address?: string;
      signedTxXdr?: string;
      role?: string;
    };
    if (!isValidStellarAddress(address) || !isBoundedString(signedTxXdr, 20_000)) {
      return NextResponse.json(
        { error: "address and signedTxXdr are required", code: "invalid_challenge" },
        { status: 400 }
      );
    }

    // Validate the SEP-10 challenge — throws SiwsError with a clear code/status.
    const wallet = verifyChallenge(signedTxXdr, address);

    // Provision the wallet identity and mint a session cookie.
    const identity = await issueSessionForWallet(wallet, role);
    const token = await signSessionToken({
      sub: identity.userId,
      wallet,
      role: identity.role,
    });

    const response = NextResponse.json({
      userId: identity.userId,
      role: identity.role,
      isNewUser: identity.isNewUser,
    });
    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    return response;
  } catch (err) {
    if (err instanceof SiwsError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[siws/verify]", msg);
    return NextResponse.json(
      { error: "Authentication failed", code: "session_failed" },
      { status: 500 }
    );
  }
}
