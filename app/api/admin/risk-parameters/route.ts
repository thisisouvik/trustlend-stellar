import { NextRequest, NextResponse } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { requireApiAdmin, UnauthorizedError } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import {
  DEFAULT_ASSET_RISK_CONFIGS,
  DEFAULT_INTEREST_RATE_CURVES,
  DEFAULT_PROTOCOL_FEES,
  INITIAL_RISK_AUDIT_LOG,
  RISK_PARAMETER_BOUNDS,
  RiskParametersState,
  RiskParameterUpdateAudit,
  validateAssetRiskConfig,
  validateInterestRateCurveConfig,
  validateProtocolFeeConfig,
} from "@/lib/risk/parameters";

// In-memory persistent state for active session (mirrors on-chain Soroban contract settings)
const currentRiskState: RiskParametersState = {
  assets: [...DEFAULT_ASSET_RISK_CONFIGS],
  curves: [...DEFAULT_INTEREST_RATE_CURVES],
  protocolFees: { ...DEFAULT_PROTOCOL_FEES },
  auditHistory: [...INITIAL_RISK_AUDIT_LOG],
};

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await enforceRouteRateLimit(request);
    if (rateLimit) return rateLimit;

    await requireApiAdmin();

    return NextResponse.json(
      {
        success: true,
        data: currentRiskState,
        bounds: RISK_PARAMETER_BOUNDS,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof UnauthorizedError) {
      const unauthenticated = error.message === "Not authenticated";
      return NextResponse.json(
        {
          success: false,
          error: unauthenticated ? "Authentication required" : "Admin access required",
        },
        { status: unauthenticated ? 401 : 403 }
      );
    }
    const message = error instanceof Error ? error.message : "Failed to fetch risk parameters";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await enforceRouteRateLimit(request);
    if (rateLimit) return rateLimit;

    const user = await requireApiAdmin();
    const adminEmail = user.email || "admin@trustlend.org";

    const body = await request.json();
    const { category, targetId, updates, reason, txHash } = body;

    if (!category || !updates) {
      return NextResponse.json(
        { success: false, error: "Missing category or updates payload" },
        { status: 400 }
      );
    }

    if (!reason || reason.trim().length < 5) {
      return NextResponse.json(
        { success: false, error: "A valid rationale (min 5 characters) is required for parameter changes" },
        { status: 400 }
      );
    }

    let previousVal = "";
    let newVal = "";
    let targetName = "";

    // ── 1. Collateral Factor / LTV Updates ──
    if (category === "collateral_ltv") {
      const asset = currentRiskState.assets.find(
        (a) => a.assetSymbol === targetId || a.assetAddress === targetId
      );
      if (!asset) {
        return NextResponse.json({ success: false, error: "Asset not found" }, { status: 404 });
      }

      const validation = validateAssetRiskConfig(updates);
      if (!validation.valid) {
        return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
      }

      targetName = `${asset.assetSymbol} Risk Parameters`;
      previousVal = `LTV: ${(asset.collateralFactorBps / 100).toFixed(2)}%, Vol: ${(asset.volatilityBps / 100).toFixed(2)}%`;

      Object.assign(asset, updates);

      newVal = `LTV: ${(asset.collateralFactorBps / 100).toFixed(2)}%, Vol: ${(asset.volatilityBps / 100).toFixed(2)}%`;
    }

    // ── 2. Interest Rate Curve Updates ──
    else if (category === "interest_curve") {
      const curve = currentRiskState.curves.find((c) => c.poolId === Number(targetId));
      if (!curve) {
        return NextResponse.json({ success: false, error: "Interest curve / pool not found" }, { status: 404 });
      }

      const validation = validateInterestRateCurveConfig(updates);
      if (!validation.valid) {
        return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
      }

      targetName = `${curve.poolName} Rate Curve`;
      previousVal = `Base: ${(curve.baseRateBps / 100).toFixed(2)}%, Kink: ${(curve.kinkBps / 100).toFixed(2)}%, Jump: ${(curve.jumpMultiplierBps / 100).toFixed(2)}%`;

      Object.assign(curve, updates);

      newVal = `Base: ${(curve.baseRateBps / 100).toFixed(2)}%, Kink: ${(curve.kinkBps / 100).toFixed(2)}%, Jump: ${(curve.jumpMultiplierBps / 100).toFixed(2)}%`;
    }

    // ── 3. Protocol Fees & Circuit Breakers ──
    else if (category === "protocol_fees") {
      const validation = validateProtocolFeeConfig(updates);
      if (!validation.valid) {
        return NextResponse.json({ success: false, error: validation.error }, { status: 400 });
      }

      targetName = "Protocol Fees & Security";
      previousVal = `Flash Fee: ${(currentRiskState.protocolFees.flashLoanFeeBps / 100).toFixed(2)}%, Platform Fee: ${(currentRiskState.protocolFees.platformFeeBps / 100).toFixed(2)}%`;

      Object.assign(currentRiskState.protocolFees, updates);

      newVal = `Flash Fee: ${(currentRiskState.protocolFees.flashLoanFeeBps / 100).toFixed(2)}%, Platform Fee: ${(currentRiskState.protocolFees.platformFeeBps / 100).toFixed(2)}%`;
    } else {
      return NextResponse.json({ success: false, error: "Invalid parameter category" }, { status: 400 });
    }

    // ── 4. Append Audit Entry ──
    const auditEntry: RiskParameterUpdateAudit = {
      id: `audit-${Date.now()}`,
      category,
      targetName,
      updatedBy: adminEmail,
      previousValue: previousVal,
      newValue: newVal,
      reason,
      timestamp: new Date().toISOString(),
      txHash: txHash || undefined,
    };

    currentRiskState.auditHistory.unshift(auditEntry);
    if (currentRiskState.auditHistory.length > 50) {
      currentRiskState.auditHistory.pop();
    }

    return NextResponse.json(
      {
        success: true,
        message: `Successfully updated ${targetName}`,
        audit: auditEntry,
        data: currentRiskState,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof UnauthorizedError) {
      const unauthenticated = error.message === "Not authenticated";
      return NextResponse.json(
        {
          success: false,
          error: unauthenticated ? "Authentication required" : "Admin access required",
        },
        { status: unauthenticated ? 401 : 403 }
      );
    }
    const message = error instanceof Error ? error.message : "Failed to execute parameter update";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
