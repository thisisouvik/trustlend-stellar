/**
 * What the testnet deployment CLI deploys, and in what order (Issue #270).
 *
 * Keeping this as data rather than a sequence of shell commands means the
 * deploy script, its `--only` filter, and the `.env` writer all read from one
 * list — adding a contract is a single entry here.
 */

export type ContractSpec = {
  /** Stable key used by `--only` and in the deployment manifest. */
  key: string;
  /** Human-readable name for progress output. */
  label: string;
  /** WASM basename produced by `stellar contract build`. */
  wasm: string;
  /** Env var that receives the deployed contract id. */
  envVar: string;
  /**
   * Whether the app breaks without this contract. Optional ones can be skipped
   * with `--only` without leaving the frontend half-configured.
   */
  required: boolean;
};

/**
 * Deploy order matters: contracts with no dependencies first, then the ones
 * that need to be initialized with another contract's id (governance needs
 * lending + reputation; vesting and airdrop need the TLEND token; referral,
 * loyalty and the auto-compound vault need lending). Initialization runs in
 * each contract's constructor at deploy time (Issue #352), so a dependency
 * must already be deployed when its dependant is.
 */
export const CONTRACTS: ContractSpec[] = [
  {
    key: "reputation",
    label: "BorrowerReputationContract",
    wasm: "borrower_reputation.wasm",
    envVar: "NEXT_PUBLIC_REPUTATION_CONTRACT_ID",
    required: true,
  },
  {
    key: "escrow",
    label: "EscrowContract",
    wasm: "escrow.wasm",
    envVar: "NEXT_PUBLIC_ESCROW_CONTRACT_ID",
    required: true,
  },
  {
    key: "lending",
    label: "LendingContract",
    wasm: "lending.wasm",
    envVar: "NEXT_PUBLIC_LENDING_CONTRACT_ID",
    required: true,
  },
  {
    key: "default_management",
    label: "DefaultManagementContract",
    wasm: "default_management.wasm",
    envVar: "NEXT_PUBLIC_DEFAULT_CONTRACT_ID",
    required: true,
  },
  {
    // The app reads NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID
    // (lib/contracts/pooled-lending.ts) but contracts/scripts/deploy.sh never
    // deployed it, so pool features came up unconfigured after a fresh deploy.
    key: "pooled_lending",
    label: "PooledLendingContract",
    wasm: "pooled_lending.wasm",
    envVar: "NEXT_PUBLIC_POOLED_LENDING_CONTRACT_ID",
    required: true,
  },
  {
    key: "governance",
    label: "GovernanceContract",
    wasm: "governance.wasm",
    envVar: "NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID",
    required: true,
  },
  {
    key: "multisig_admin",
    label: "MultiSigAdminContract",
    wasm: "multisig_admin.wasm",
    envVar: "NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID",
    required: true,
  },
  {
    key: "tlend_token",
    label: "TlendTokenContract",
    wasm: "tlend_token.wasm",
    envVar: "NEXT_PUBLIC_TLEND_TOKEN_CONTRACT_ID",
    required: false,
  },
  {
    key: "tlend_vesting",
    label: "TlendVestingContract",
    wasm: "tlend_vesting.wasm",
    envVar: "NEXT_PUBLIC_TLEND_VESTING_CONTRACT_ID",
    required: false,
  },
  {
    key: "tlend_airdrop",
    label: "TlendAirdropContract",
    wasm: "tlend_airdrop.wasm",
    envVar: "NEXT_PUBLIC_TLEND_AIRDROP_CONTRACT_ID",
    required: false,
  },
  // ── Contracts the lending contract calls into (Phase 2.2) ────────────────
  {
    key: "referral_rewards",
    label: "ReferralRewardsContract",
    wasm: "referral_rewards.wasm",
    envVar: "NEXT_PUBLIC_REFERRAL_REWARDS_CONTRACT_ID",
    required: false,
  },
  {
    key: "borrower_loyalty",
    label: "BorrowerLoyaltyContract",
    wasm: "borrower_loyalty.wasm",
    envVar: "NEXT_PUBLIC_BORROWER_LOYALTY_CONTRACT_ID",
    required: false,
  },
  {
    key: "treasury",
    label: "TreasuryContract",
    wasm: "treasury.wasm",
    envVar: "NEXT_PUBLIC_TREASURY_CONTRACT_ID",
    required: false,
  },
  // ── Standalone protocol modules ──────────────────────────────────────────
  {
    key: "auto_compound_vault",
    label: "AutoCompoundVaultContract",
    wasm: "auto_compound_vault.wasm",
    envVar: "NEXT_PUBLIC_AUTO_COMPOUND_VAULT_CONTRACT_ID",
    required: false,
  },
  {
    key: "liquidation_auction",
    label: "LiquidationAuctionContract",
    wasm: "liquidation_auction.wasm",
    envVar: "NEXT_PUBLIC_LIQUIDATION_AUCTION_CONTRACT_ID",
    required: false,
  },
  {
    key: "usdc_lending_pool",
    label: "UsdcLendingPoolContract",
    wasm: "usdc_lending_pool.wasm",
    envVar: "NEXT_PUBLIC_USDC_LENDING_POOL_CONTRACT_ID",
    required: false,
  },
  {
    key: "zk_credit_verifier",
    label: "ZkCreditVerifierContract",
    wasm: "zk_credit_verifier.wasm",
    envVar: "NEXT_PUBLIC_ZK_CREDIT_VERIFIER_CONTRACT_ID",
    required: false,
  },
];

export const CONTRACT_KEYS = CONTRACTS.map((contract) => contract.key);

/**
 * Resolve a `--only=a,b,c` selection against the manifest.
 *
 * Returns the contracts in canonical deploy order regardless of the order the
 * caller listed them, because initialization depends on it.
 */
export function selectContracts(only?: string): {
  selected: ContractSpec[];
  unknown: string[];
} {
  if (!only || only.trim() === "") {
    return { selected: CONTRACTS, unknown: [] };
  }

  const requested = only
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const known = new Set(CONTRACT_KEYS);
  const unknown = requested.filter((key) => !known.has(key));
  const wanted = new Set(requested);

  return {
    selected: CONTRACTS.filter((contract) => wanted.has(contract.key)),
    unknown,
  };
}
