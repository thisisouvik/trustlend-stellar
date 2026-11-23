#!/usr/bin/env bash
# =============================================================================
# SUPERSEDED by `npm run deploy:testnet` (issue #270).
#
# The Node CLI at scripts/deploy-testnet.ts does everything this script does,
# plus: it runs on Windows too (so this file and deploy.ps1 no longer have to be
# kept in sync by hand), it creates and funds the admin key for you, it deploys
# the pooled_lending contract this script omits, and it writes the contract IDs
# into .env.local directly instead of leaving you to copy .env.contracts across.
#
#   npm run deploy:testnet            # deploy everything
#   npm run deploy:testnet:dry        # preview without touching the network
#   npm run deploy:testnet -- --help  # all options
#
# This script is kept for now so existing muscle memory and CI jobs keep working.
# =============================================================================
# =============================================================================
# TrustLend – Soroban Contract Deployment Script
# =============================================================================
# Prerequisites:
#   1. Rust + wasm32 target:
#        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#        rustup target add wasm32-unknown-unknown
#   2. Stellar CLI ≥ 22:
#        cargo install --locked stellar-cli --features opt
#   3. Run:  stellar keys generate trustlend-admin --global
#            stellar keys use trustlend-admin
#            stellar keys address trustlend-admin   ← note your admin address
#   4. Fund on testnet:
#        curl "https://friendbot.stellar.org/?addr=<YOUR_ADMIN_ADDRESS>"
# =============================================================================

set -euo pipefail

NETWORK="testnet"
ADMIN_KEY="trustlend-admin"
ADMIN_ADDRESS=$(stellar keys address "$ADMIN_KEY")

echo "═══════════════════════════════════════════════════"
echo "  TrustLend Contract Deployment — Stellar Testnet"
echo "  Admin: $ADMIN_ADDRESS"
echo "═══════════════════════════════════════════════════"
echo ""

# ── Step 1: Build all contracts ───────────────────────────────────────────────

echo "▶ Building Rust contracts…"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."   # contracts/ directory

stellar contract build

echo "✔ Build complete"
echo ""

# ── Step 2: Deploy + initialise contracts ─────────────────────────────────────
# Every contract initialises in its Soroban constructor, whose arguments are
# passed after `--` on `stellar contract deploy` (issue #352). Deployment and
# initialisation are one atomic transaction, so there is no window in which a
# contract is live but uninitialised and an observer could front-run
# `initialize` to claim admin rights. Order matters: contracts whose
# constructors take another contract's id are deployed after it.

# deploy_contract <wasm-basename> [constructor args...]
deploy_contract() {
  local wasm="$1"; shift
  stellar contract deploy \
    --wasm "target/wasm32v1-none/release/${wasm}.wasm" \
    --network "$NETWORK" \
    --source "$ADMIN_KEY" \
    -- "$@"
}

echo "▶ Deploying BorrowerReputationContract…"
REPUTATION_ID=$(deploy_contract borrower_reputation --admin "$ADMIN_ADDRESS")
echo "  ✔ REPUTATION_CONTRACT_ID = $REPUTATION_ID"

echo ""
echo "▶ Deploying EscrowContract…"
ESCROW_ID=$(deploy_contract escrow --admin "$ADMIN_ADDRESS")
echo "  ✔ ESCROW_CONTRACT_ID = $ESCROW_ID"

echo ""
echo "▶ Deploying LendingContract…"
LENDING_ID=$(deploy_contract lending --admin "$ADMIN_ADDRESS")
echo "  ✔ LENDING_CONTRACT_ID = $LENDING_ID"

echo ""
echo "▶ Deploying DefaultManagementContract (insurance_balance = 0)…"
DEFAULT_ID=$(deploy_contract default_management \
  --admin "$ADMIN_ADDRESS" \
  --initial_insurance_balance 0)
echo "  ✔ DEFAULT_CONTRACT_ID = $DEFAULT_ID"

# Governance: 3-day voting window, quorum 500, min proposer power 150 (Silver),
# fee cap 1000 bps (10 %), 24h timelock delay (86400s). Voting power = reputation score.
echo ""
echo "▶ Deploying GovernanceContract…"
GOVERNANCE_ID=$(deploy_contract governance \
  --admin "$ADMIN_ADDRESS" \
  --lending "$LENDING_ID" \
  --reputation "$REPUTATION_ID" \
  --voting_period_secs 259200 \
  --quorum_votes 500 \
  --min_proposer_power 150 \
  --max_fee_bps 1000 \
  --timelock_delay_secs 86400)
echo "  ✔ GOVERNANCE_CONTRACT_ID = $GOVERNANCE_ID"

# ── Multi-Sig Admin (issue #73) ────────────────────────────────────────────────
# Comma-separated G... signer addresses + how many must approve before a rare,
# high-impact config change (whitelisting assets, fee tables, linking
# governance/oracle, moving insurance funds) executes. Defaults to a 1-of-1
# multisig using the deploying admin alone — expand the signer set later via
# the contract's own AddSigner/SetThreshold actions.
#   export MULTISIG_SIGNERS="G...,G...,G..."
#   export MULTISIG_THRESHOLD=2
MULTISIG_SIGNERS="${MULTISIG_SIGNERS:-$ADMIN_ADDRESS}"
MULTISIG_THRESHOLD="${MULTISIG_THRESHOLD:-1}"

IFS=',' read -ra SIGNER_ARR <<< "$MULTISIG_SIGNERS"
SIGNERS_JSON="["
for i in "${!SIGNER_ARR[@]}"; do
  [ "$i" -gt 0 ] && SIGNERS_JSON+=","
  SIGNERS_JSON+="\"${SIGNER_ARR[$i]}\""
done
SIGNERS_JSON+="]"

echo ""
echo "▶ Deploying MultiSigAdminContract (${MULTISIG_THRESHOLD}-of-${#SIGNER_ARR[@]})…"
MULTISIG_ID=$(deploy_contract multisig_admin \
  --signers "$SIGNERS_JSON" \
  --threshold "$MULTISIG_THRESHOLD")
echo "  ✔ MULTISIG_ADMIN_CONTRACT_ID = $MULTISIG_ID"

# ── TLEND governance token + distribution (issue #107) ───────────────────────
# Decimals/name/symbol are fixed by the constructor.

echo ""
echo "▶ Deploying TlendTokenContract (TLEND, 7 decimals)…"
TLEND_TOKEN_ID=$(deploy_contract tlend_token \
  --admin "$ADMIN_ADDRESS" \
  --decimals 7 \
  --name "TrustLend" \
  --symbol "TLEND")
echo "  ✔ TLEND_TOKEN_CONTRACT_ID = $TLEND_TOKEN_ID"

echo ""
echo "▶ Deploying TlendVestingContract…"
TLEND_VESTING_ID=$(deploy_contract tlend_vesting \
  --admin "$ADMIN_ADDRESS" \
  --token "$TLEND_TOKEN_ID")
echo "  ✔ TLEND_VESTING_CONTRACT_ID = $TLEND_VESTING_ID"

# The airdrop's Merkle root of eligible (address, amount) leaves is a
# constructor argument — generate one off-chain and pass it in:
#   export TLEND_AIRDROP_MERKLE_ROOT=<64-char hex sha256 root>
# Without it the airdrop is not deployed (it would be useless without a root).
TLEND_AIRDROP_ID=""
if [ -n "${TLEND_AIRDROP_MERKLE_ROOT:-}" ]; then
  echo ""
  echo "▶ Deploying TlendAirdropContract…"
  TLEND_AIRDROP_ID=$(deploy_contract tlend_airdrop \
    --admin "$ADMIN_ADDRESS" \
    --token "$TLEND_TOKEN_ID" \
    --merkle_root "$TLEND_AIRDROP_MERKLE_ROOT")
  echo "  ✔ TLEND_AIRDROP_CONTRACT_ID = $TLEND_AIRDROP_ID"
else
  echo ""
  echo "ℹ Skipping TlendAirdropContract (set TLEND_AIRDROP_MERKLE_ROOT to deploy it)."
fi

echo ""
echo "✔ All contracts deployed and initialised"

# ── Step 3: Wire contracts together ───────────────────────────────────────────
# Admin-authorised links between already-initialised contracts.

# Escrow takes custody of lender funds and only accepts allowlisted tokens
# (Issue #417). Allow the native XLM Stellar Asset Contract.
echo ""
XLM_SAC_ID=$(stellar contract id asset --asset native --network "$NETWORK")
echo "▶ Allowing native XLM ($XLM_SAC_ID) for escrow holds…"
stellar contract invoke \
  --id "$ESCROW_ID" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  -- set_allowed_token \
  --caller "$ADMIN_ADDRESS" \
  --token "$XLM_SAC_ID" \
  --allowed true

# Lending reads every borrower's tier and credit limit from the reputation
# contract (Issue #335); loan requests are rejected until this link exists.
echo "▶ Linking LendingContract → BorrowerReputationContract…"
stellar contract invoke \
  --id "$LENDING_ID" \
  --source "$ADMIN_KEY" \
  --network "$NETWORK" \
  -- set_reputation_contract \
  --admin "$ADMIN_ADDRESS" \
  --reputation "$REPUTATION_ID"

echo "▶ Linking MultiSigAdmin → Lending, Default Management, Reputation…"
stellar contract invoke --id "$LENDING_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- set_multisig_admin --admin "$ADMIN_ADDRESS" --multisig "$MULTISIG_ID"
stellar contract invoke --id "$DEFAULT_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- set_multisig_admin --admin "$ADMIN_ADDRESS" --multisig "$MULTISIG_ID"
stellar contract invoke --id "$REPUTATION_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- set_multisig_admin --admin "$ADMIN_ADDRESS" --multisig "$MULTISIG_ID"
echo "  ✔ whitelist_asset / set_flash_loan_fee_bps / set_governance / set_oracle /"
echo "    add_to_insurance / trigger_insurance_payout are now multisig-gated —"
echo "    the plain admin key can no longer call them directly."

# Linking Governance → Lending now has to go THROUGH the multisig
# (set_governance is multisig-gated). With the default 1-of-1 setup, propose
# immediately reaches the threshold, so execute can follow right away.
echo "▶ Proposing + executing SetGovernance (Lending ← Governance) via multisig…"
PROPOSAL_ID=$(stellar contract invoke --id "$MULTISIG_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- propose --proposer "$ADMIN_ADDRESS" \
  --action "{\"SetGovernance\":[\"$LENDING_ID\",\"$GOVERNANCE_ID\"]}")
stellar contract invoke --id "$MULTISIG_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- execute --proposal_id "$PROPOSAL_ID"
echo "  ✔ Governance linked (only votes can change the fee now)"
echo "  ℹ For a real N-of-M multisig, other signers must call \`approve\` on this"
echo "    contract before \`execute\` will succeed — see lib/contracts/multisig-admin.ts"

# ── Optional: register the Credit Oracle ──────────────────────────────────────
# `set_oracle` is multisig-gated, so this now goes through propose + execute
# too (with the default 1-of-1 setup, execute can follow immediately).
# Set ORACLE_ADDRESS in your shell to auto-authorize the oracle that may post
# off-chain credit scores (see scripts/oracle-post-credit-score.mjs).
#   export ORACLE_ADDRESS=$(stellar keys address trustlend-oracle)
if [ -n "${ORACLE_ADDRESS:-}" ]; then
  echo "▶ Proposing + executing SetOracle ($ORACLE_ADDRESS) via multisig…"
  ORACLE_PROPOSAL_ID=$(stellar contract invoke --id "$MULTISIG_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
    -- propose --proposer "$ADMIN_ADDRESS" \
    --action "{\"SetOracle\":[\"$REPUTATION_ID\",\"$ORACLE_ADDRESS\"]}")
  stellar contract invoke --id "$MULTISIG_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
    -- execute --proposal_id "$ORACLE_PROPOSAL_ID"
  echo "  ✔ Oracle authorized"
else
  echo "ℹ Skipping oracle registration (set ORACLE_ADDRESS to enable). Run later via"
  echo "    the MultiSigAdmin contract's propose/approve/execute (see lib/contracts/multisig-admin.ts)."
fi

# TLEND_TOTAL_SUPPLY is minted to the admin, who then funds individual vesting
# schedules (via `create_vesting_schedule`) and the airdrop pool (via `fund`)
# out of that balance as needed.
TLEND_TOTAL_SUPPLY="${TLEND_TOTAL_SUPPLY:-1000000000000}" # 100M TLEND @ 7 decimals

echo ""
echo "▶ Minting initial TLEND supply…"
stellar contract invoke --id "$TLEND_TOKEN_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- mint --to "$ADMIN_ADDRESS" --amount "$TLEND_TOTAL_SUPPLY"
echo "  ✔ Minted $TLEND_TOTAL_SUPPLY raw units of TLEND to $ADMIN_ADDRESS"
echo "  ℹ Create schedules later with \`create_vesting_schedule\` (admin, beneficiary,"
echo "    category, total_amount, terms) — each call escrows tokens from the admin."
if [ -n "$TLEND_AIRDROP_ID" ]; then
  echo "  ℹ Fund the airdrop pool with the \`fund\` invocation before claims open."
fi

echo ""
echo "✔ All contracts wired"

# ── Step 4: Generate TypeScript bindings ──────────────────────────────────────

BINDINGS_OUT="../../lib/contracts/generated"
mkdir -p "$BINDINGS_OUT"

echo ""
echo "▶ Generating TypeScript bindings…"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$REPUTATION_ID" \
  --output-dir "$BINDINGS_OUT/reputation"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$ESCROW_ID" \
  --output-dir "$BINDINGS_OUT/escrow"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$LENDING_ID" \
  --output-dir "$BINDINGS_OUT/lending"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$DEFAULT_ID" \
  --output-dir "$BINDINGS_OUT/default_management"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$GOVERNANCE_ID" \
  --output-dir "$BINDINGS_OUT/governance"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$MULTISIG_ID" \
  --output-dir "$BINDINGS_OUT/multisig_admin"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$TLEND_TOKEN_ID" \
  --output-dir "$BINDINGS_OUT/tlend_token"

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$TLEND_VESTING_ID" \
  --output-dir "$BINDINGS_OUT/tlend_vesting"

if [ -n "$TLEND_AIRDROP_ID" ]; then
  stellar contract bindings typescript \
    --network "$NETWORK" \
    --id "$TLEND_AIRDROP_ID" \
    --output-dir "$BINDINGS_OUT/tlend_airdrop"
fi

echo "  ✔ Bindings written to lib/contracts/generated/"

# ── Step 5: Write .env.local snippet ─────────────────────────────────────────

ENV_OUT="../../.env.contracts"
cat > "$ENV_OUT" <<EOF
# ── Soroban Contract IDs (generated by deploy.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")) ──
NEXT_PUBLIC_REPUTATION_CONTRACT_ID=$REPUTATION_ID
NEXT_PUBLIC_ESCROW_CONTRACT_ID=$ESCROW_ID
NEXT_PUBLIC_LENDING_CONTRACT_ID=$LENDING_ID
NEXT_PUBLIC_DEFAULT_CONTRACT_ID=$DEFAULT_ID
NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_ID
NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID=$MULTISIG_ID
NEXT_PUBLIC_TLEND_TOKEN_CONTRACT_ID=$TLEND_TOKEN_ID
NEXT_PUBLIC_TLEND_VESTING_CONTRACT_ID=$TLEND_VESTING_ID
NEXT_PUBLIC_TLEND_AIRDROP_CONTRACT_ID=$TLEND_AIRDROP_ID
NEXT_PUBLIC_ADMIN_ADDRESS=$ADMIN_ADDRESS
NEXT_PUBLIC_ORACLE_ADDRESS=${ORACLE_ADDRESS:-}
EOF

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Deployment complete!"
echo ""
echo "  Copy the values from .env.contracts into .env.local:"
echo "  cat .env.contracts >> .env.local"
echo ""
echo "  Contract IDs:"
echo "    Reputation  : $REPUTATION_ID"
echo "    Escrow      : $ESCROW_ID"
echo "    Lending     : $LENDING_ID"
echo "    Default Mgmt: $DEFAULT_ID"
echo "    Governance  : $GOVERNANCE_ID"
echo "    Multisig    : $MULTISIG_ID"
echo "    TLEND Token : $TLEND_TOKEN_ID"
echo "    TLEND Vest. : $TLEND_VESTING_ID"
echo "    TLEND Aird. : $TLEND_AIRDROP_ID"
echo "═══════════════════════════════════════════════════"
