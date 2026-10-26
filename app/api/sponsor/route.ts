import { NextRequest, NextResponse } from "next/server";
import {
  Address,
  FeeBumpTransaction,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth/session";
import { CONTRACTS } from "@/lib/deployment/contracts-manifest";
import { enforceRouteRateLimit, enforceSponsorRateLimit } from "@/lib/rate-limit";

/** Maximum base64 XDR payload length accepted by the sponsorship endpoint. */
const MAX_XDR_LENGTH = 65_536;

/** Maximum number of operations allowed inside a single sponsored transaction. */
const MAX_SPONSORED_OPERATIONS = 5;

/** Maximum sponsored fee in stroops (0.01 XLM = 100,000 stroops). */
const SPONSOR_MAX_FEE_STROOPS = "100000";

/** Official TrustLend protocol payment memo prefix pattern (`TL-RPY:`, `TL-FUND:`, `TL-DEPOSIT:`, `TL-WDR:`). */
const TRUSTLEND_PROTOCOL_MEMO_RE = /^TL-(RPY|FUND|DEPOSIT|WDR):[A-Za-z0-9_-]{1,20}$/;

/**
 * Privileged administrative contract methods that must NEVER be sponsored via
 * the borrower gasless relay.
 */
export const FORBIDDEN_CONTRACT_METHODS = new Set<string>([
  "initialize",
  "__constructor",
  "upgrade",
  "set_multisig_admin",
  "setup_multisig",
  "pause",
  "unpause",
  "trigger_insurance_payout",
  "add_to_insurance",
  "set_governance",
  "set_oracle",
  "whitelist_asset",
  "set_collateral_config",
  "update_collateral_price",
  "set_flash_loan_fee_bps",
  "update_platform_fee",
  "freeze_account",
  "unfreeze_account",
  "sweep_unclaimed",
  "set_reputation_contract",
  "set_referral_contract",
  "set_loyalty_contract",
  "set_treasury",
  "set_fee_token",
  "set_lending_contract",
]);

/**
 * Approved borrower / protocol contract methods eligible for fee sponsorship.
 */
export const APPROVED_CONTRACT_METHODS = new Set<string>([
  // LendingContract borrower & loan lifecycle operations
  "create_loan_request",
  "cancel_loan_request",
  "deposit_collateral",
  "withdraw_collateral",
  "switch_rate_model",
  "record_payment",
  "repay_loan",
  "execute_flash_loan",
  // BorrowerReputationContract borrower profile operations
  "initialize_profile",
  "register_borrower",
  "get_profile",
  "has_profile",
  // EscrowContract operations
  "create_hold",
  "release_hold",
  "revoke_hold",
  // ZkCreditVerifierContract borrower proof operations
  "submit_zk_proof",
  "verify_proof",
  // BorrowerLoyaltyContract & ReferralRewardsContract borrower claims
  "claim_rewards",
  "claim_loyalty_reward",
  "claim_referral_reward",
  "register_referral",
  "claim",
  // GovernanceContract participation
  "propose",
  "vote",
  // LiquidationAuctionContract & AutoCompoundVaultContract user operations
  "bid",
  "settle_auction",
  "deposit",
  "withdraw",
]);

/**
 * Collect all configured official TrustLend smart contract IDs from environment
 * variables (defined in `CONTRACTS` manifest + `TRUSTLEND_ALLOWED_CONTRACT_IDS`).
 */
export function getOfficialTrustLendContractIds(
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const ids = new Set<string>();

  for (const spec of CONTRACTS) {
    const value = env[spec.envVar]?.trim();
    if (value) {
      ids.add(value);
    }
  }

  const extra = env.TRUSTLEND_ALLOWED_CONTRACT_IDS;
  if (extra) {
    for (const item of extra.split(",")) {
      const trimmed = item.trim();
      if (trimmed) {
        ids.add(trimmed);
      }
    }
  }

  return ids;
}

export type SponsorValidationResult =
  | {
      ok: true;
      innerTx: Transaction;
      sourceWallet: string;
      targetContracts: string[];
      operations: string[];
    }
  | {
      ok: false;
      status: 400 | 403;
      error: string;
      reason: string;
    };

/**
 * Inspect and validate the inner Stellar transaction XDR before wrapping it in
 * a platform-sponsored `FeeBumpTransaction`.
 */
export function validateSponsoredTransactionXdr(
  rawXdr: unknown,
  networkPassphrase: string,
  env: NodeJS.ProcessEnv = process.env
): SponsorValidationResult {
  if (typeof rawXdr !== "string" || rawXdr.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Missing transaction XDR",
      reason: "missing_xdr",
    };
  }

  const trimmedXdr = rawXdr.trim();
  if (trimmedXdr.length > MAX_XDR_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "Transaction XDR exceeds maximum allowed size",
      reason: "xdr_too_large",
    };
  }

  let parsedTx: Transaction | FeeBumpTransaction;
  try {
    parsedTx = TransactionBuilder.fromXDR(trimmedXdr, networkPassphrase);
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: "Malformed transaction XDR",
      reason: err instanceof Error ? err.message : "invalid_xdr_encoding",
    };
  }

  if ("innerTransaction" in parsedTx) {
    return {
      ok: false,
      status: 400,
      error: "Cannot sponsor a transaction that is already wrapped in a FeeBumpTransaction",
      reason: "already_fee_bumped",
    };
  }

  const innerTx = parsedTx as Transaction;
  const sourceWallet = innerTx.source;

  if (!sourceWallet || !StrKey.isValidEd25519PublicKey(sourceWallet)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid source account in inner transaction",
      reason: "invalid_source_account",
    };
  }

  // Prevent using the platform admin/sponsor key as the inner transaction source
  const adminAddress = env.NEXT_PUBLIC_ADMIN_ADDRESS?.trim();
  if (adminAddress && sourceWallet === adminAddress) {
    return {
      ok: false,
      status: 403,
      error: "Inner transaction cannot use the platform admin account as source",
      reason: "admin_source_spoofing",
    };
  }

  if (!Array.isArray(innerTx.operations) || innerTx.operations.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Inner transaction contains no operations",
      reason: "empty_operations",
    };
  }

  if (innerTx.operations.length > MAX_SPONSORED_OPERATIONS) {
    return {
      ok: false,
      status: 400,
      error: `Inner transaction exceeds maximum of ${MAX_SPONSORED_OPERATIONS} operations`,
      reason: "too_many_operations",
    };
  }

  const officialContracts = getOfficialTrustLendContractIds(env);
  const platformWallet =
    env.NEXT_PUBLIC_PLATFORM_STELLAR_ADDRESS?.trim() ||
    env.PLATFORM_FEE_WALLET?.trim() ||
    "";
  const txMemoText =
    innerTx.memo && innerTx.memo.type === "text" && innerTx.memo.value
      ? String(innerTx.memo.value)
      : "";

  const targetContracts: string[] = [];
  const operationsSummary: string[] = [];

  for (let idx = 0; idx < innerTx.operations.length; idx++) {
    const op = innerTx.operations[idx] as {
      type?: string;
      source?: string;
      func?: xdr.HostFunction;
      destination?: string;
      asset?: { isNative?: () => boolean };
    };

    // Every operation must originate from the same borrower source account
    if (op.source && op.source !== sourceWallet) {
      return {
        ok: false,
        status: 403,
        error: `Operation ${idx} specifies an unauthorized source account`,
        reason: "mismatched_operation_source",
      };
    }

    if (op.type === "invokeHostFunction") {
      if (!op.func || op.func.switch().name !== "hostFunctionTypeInvokeContract") {
        return {
          ok: false,
          status: 403,
          error: `Operation ${idx} is not a valid contract invocation`,
          reason: "non_contract_host_function",
        };
      }

      let contractId: string;
      let method: string;
      try {
        const invocation = op.func.invokeContract();
        contractId = Address.fromScAddress(invocation.contractAddress()).toString();
        method = invocation.functionName().toString();
      } catch {
        return {
          ok: false,
          status: 400,
          error: `Operation ${idx} contains a malformed contract invocation`,
          reason: "malformed_contract_invocation",
        };
      }

      if (!officialContracts.has(contractId)) {
        return {
          ok: false,
          status: 403,
          error: `Operation ${idx} targets an unrecognized or unauthorized contract: ${contractId}`,
          reason: `unauthorized_contract:${contractId}`,
        };
      }

      if (FORBIDDEN_CONTRACT_METHODS.has(method) || !APPROVED_CONTRACT_METHODS.has(method)) {
        return {
          ok: false,
          status: 403,
          error: `Contract method "${method}" is not eligible for fee sponsorship`,
          reason: `unauthorized_contract_method:${method}`,
        };
      }

      targetContracts.push(contractId);
      operationsSummary.push(`invoke:${contractId}:${method}`);
      continue;
    }

    if (op.type === "payment") {
      const hasApprovedMemo = TRUSTLEND_PROTOCOL_MEMO_RE.test(txMemoText);
      const targetsPlatformWallet =
        Boolean(platformWallet) && op.destination === platformWallet;

      if (!hasApprovedMemo && !targetsPlatformWallet) {
        return {
          ok: false,
          status: 403,
          error:
            "Payment operations are only sponsored for approved TrustLend protocol repayments or platform destinations",
          reason: "unauthorized_payment_operation",
        };
      }

      operationsSummary.push(`payment:${op.destination ?? "unknown"}`);
      continue;
    }

    return {
      ok: false,
      status: 403,
      error: `Operation type "${op.type ?? "unknown"}" is not approved for TrustLend fee sponsorship`,
      reason: `disallowed_operation_type:${op.type ?? "unknown"}`,
    };
  }

  return {
    ok: true,
    innerTx,
    sourceWallet,
    targetContracts,
    operations: operationsSummary,
  };
}

/**
 * TrustLend Advanced Feature: Fee Sponsorship (Gasless Transactions)
 * This endpoint allows the platform (Treasury) to sponsor transaction fees for borrowers.
 * By wrapping the user's signed transaction in a FeeBumpTransaction, the platform pays the gas,
 * enabling true "gasless" experiences for users without XLM balances.
 */
export async function POST(req: NextRequest) {
  try {
    // 1. Per-IP route rate limit
    const rateLimitResponse = await enforceRouteRateLimit(req);
    if (rateLimitResponse) {
      console.warn("[sponsor] Route IP rate limit exceeded");
      return rateLimitResponse;
    }

    // 2. Require authenticated borrower session
    let user: { id: string; walletAddress: string; role: string };
    try {
      const session = await requireAuthenticatedUser("borrower");
      if (!session?.user) {
        console.warn("[sponsor] Unauthorized sponsorship attempt: missing session user");
        return NextResponse.json(
          { error: "Unauthorized: borrower authentication required" },
          { status: 401 }
        );
      }
      user = session.user;
    } catch (authError) {
      if (isRedirectError(authError)) {
        const digest = String((authError as { digest?: string }).digest ?? "");
        if (digest.includes("/dashboard/")) {
          console.warn("[sponsor] Forbidden sponsorship attempt by non-borrower role:", digest);
          return NextResponse.json(
            { error: "Forbidden: borrower role required for fee sponsorship" },
            { status: 403 }
          );
        }
        console.warn("[sponsor] Unauthenticated sponsorship attempt redirected:", digest);
        return NextResponse.json(
          { error: "Unauthorized: borrower authentication required" },
          { status: 401 }
        );
      }

      if (authError instanceof UnauthorizedError) {
        const isRoleError = authError.message.toLowerCase().includes("role");
        console.warn("[sponsor] Unauthorized sponsorship attempt:", authError.message);
        return NextResponse.json(
          { error: authError.message },
          { status: isRoleError ? 403 : 401 }
        );
      }

      console.warn(
        "[sponsor] Authentication check failed:",
        authError instanceof Error ? authError.message : String(authError)
      );
      return NextResponse.json(
        { error: "Unauthorized: borrower authentication required" },
        { status: 401 }
      );
    }

    if (user.role !== "borrower") {
      console.warn("[sponsor] Forbidden sponsorship attempt by user %s with role %s", user.id, user.role);
      return NextResponse.json(
        { error: "Forbidden: borrower role required for fee sponsorship" },
        { status: 403 }
      );
    }

    // 3. Parse JSON request body
    let body: { xdr?: unknown };
    try {
      body = (await req.json()) as { xdr?: unknown };
    } catch (parseError) {
      console.warn(
        "[sponsor] Malformed JSON body from borrower %s:",
        user.id,
        parseError instanceof Error ? parseError.message : String(parseError)
      );
      return NextResponse.json({ error: "Invalid JSON request body" }, { status: 400 });
    }

    if (!body || typeof body.xdr !== "string" || body.xdr.trim().length === 0) {
      console.warn("[sponsor] Missing transaction XDR from borrower %s", user.id);
      return NextResponse.json({ error: "Missing transaction XDR" }, { status: 400 });
    }

    const networkPassphrase =
      process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;

    // 4. Validate the inner transaction XDR and its target contracts/operations
    const validation = validateSponsoredTransactionXdr(body.xdr, networkPassphrase);
    if (!validation.ok) {
      console.warn(
        "[sponsor] Rejected sponsorship attempt for user %s (%s): %s",
        user.id,
        validation.reason,
        validation.error
      );
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const { innerTx, sourceWallet } = validation;

    // If the borrower's session has a bound Stellar wallet, ensure the inner
    // transaction source matches it.
    if (
      user.walletAddress &&
      StrKey.isValidEd25519PublicKey(user.walletAddress) &&
      sourceWallet !== user.walletAddress
    ) {
      console.warn(
        "[sponsor] Wallet mismatch for user %s: session wallet %s vs tx source %s",
        user.id,
        user.walletAddress,
        sourceWallet
      );
      return NextResponse.json(
        { error: "Inner transaction source account does not match the authenticated borrower wallet" },
        { status: 403 }
      );
    }

    // 5. Enforce strict per-user and per-wallet rate limits
    const sponsorRateLimitResponse = await enforceSponsorRateLimit({
      userId: user.id,
      walletAddresses: [user.walletAddress, sourceWallet],
    });
    if (sponsorRateLimitResponse) {
      console.warn(
        "[sponsor] Per-user/per-wallet sponsorship rate limit exceeded for user %s (wallet %s)",
        user.id,
        sourceWallet
      );
      return sponsorRateLimitResponse;
    }

    const adminSecret = process.env.ADMIN_SECRET_KEY;
    if (!adminSecret) {
      // Simulation mode if key is not set up
      return NextResponse.json({
        success: true,
        message:
          "Fee Sponsorship Simulation: Admin secret key not configured. In production, this returns a signed FeeBumpTransaction.",
        sponsoredXdr: body.xdr,
        isSimulated: true,
      });
    }

    // 6. Load the platform Treasury keypair and ensure innerTx is not spoofing it
    const sponsorKeypair = Keypair.fromSecret(adminSecret);
    if (sourceWallet === sponsorKeypair.publicKey()) {
      console.warn(
        "[sponsor] Rejected attempt by user %s to sponsor a transaction sourced from treasury key %s",
        user.id,
        sourceWallet
      );
      return NextResponse.json(
        { error: "Inner transaction cannot use the platform sponsor account as source" },
        { status: 403 }
      );
    }

    // 7. Wrap the validated inner transaction in a FeeBumpTransaction
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      SPONSOR_MAX_FEE_STROOPS,
      innerTx,
      networkPassphrase
    );

    // 8. Sign the FeeBump wrapper with the platform's key
    feeBumpTx.sign(sponsorKeypair);

    return NextResponse.json({
      success: true,
      message: "Transaction fees sponsored successfully.",
      sponsoredXdr: feeBumpTx.toXDR(),
      isSimulated: false,
    });
  } catch (error) {
    console.error("[sponsor] Unexpected fee sponsorship error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to sponsor transaction",
      },
      { status: 500 }
    );
  }
}
