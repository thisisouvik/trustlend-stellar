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

# ── Step 2: Deploy and atomically initialise contracts via __constructor ──────
# Order matters: Reputation + Escrow first (no deps), then Lending, then Default

MULTISIG_SIGNERS="${MULTISIG_SIGNERS:-$ADMIN_ADDRESS}"
MULTISIG_THRESHOLD="${MULTISIG_THRESHOLD:-1}"

IFS=',' read -ra SIGNER_ARR <<< "$MULTISIG_SIGNERS"
SIGNERS_JSON="["
for i in "${!SIGNER_ARR[@]}"; do
  [ "$i" -gt 0 ] && SIGNERS_JSON+=","
  SIGNERS_JSON+="\"${SIGNER_ARR[$i]}\""
done
SIGNERS_JSON+="]"

echo "▶ Deploying BorrowerReputationContract…"
REPUTATION_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/borrower_reputation.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --admin "$ADMIN_ADDRESS")
echo "  ✔ REPUTATION_CONTRACT_ID = $REPUTATION_ID"

echo ""
echo "▶ Deploying EscrowContract…"
ESCROW_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/escrow.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --admin "$ADMIN_ADDRESS")
echo "  ✔ ESCROW_CONTRACT_ID = $ESCROW_ID"

echo ""
echo "▶ Deploying LendingContract…"
LENDING_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/lending.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --admin "$ADMIN_ADDRESS")
echo "  ✔ LENDING_CONTRACT_ID = $LENDING_ID"

echo ""
echo "▶ Deploying DefaultManagementContract…"
DEFAULT_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/default_management.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --admin "$ADMIN_ADDRESS" \
  --initial_insurance_balance 0)
echo "  ✔ DEFAULT_CONTRACT_ID = $DEFAULT_ID"

echo ""
echo "▶ Deploying GovernanceContract…"
GOVERNANCE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/governance.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --admin "$ADMIN_ADDRESS" \
  --lending "$LENDING_ID" \
  --reputation "$REPUTATION_ID" \
  --voting_period_secs 259200 \
  --quorum_votes 500 \
  --min_proposer_power 150 \
  --max_fee_bps 1000)
echo "  ✔ GOVERNANCE_CONTRACT_ID = $GOVERNANCE_ID"

echo ""
echo "▶ Deploying MultiSigAdminContract (${MULTISIG_THRESHOLD}-of-${#SIGNER_ARR[@]})…"
MULTISIG_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/multisig_admin.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY" \
  -- \
  --signers "$SIGNERS_JSON" \
  --threshold "$MULTISIG_THRESHOLD")
echo "  ✔ MULTISIG_ADMIN_CONTRACT_ID = $MULTISIG_ID"

# ── TLEND governance token + distribution (issue #107) ───────────────────────

echo ""
echo "▶ Deploying TlendTokenContract…"
TLEND_TOKEN_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/tlend_token.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY")
echo "  ✔ TLEND_TOKEN_CONTRACT_ID = $TLEND_TOKEN_ID"

echo ""
echo "▶ Deploying TlendVestingContract…"
TLEND_VESTING_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/tlend_vesting.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY")
echo "  ✔ TLEND_VESTING_CONTRACT_ID = $TLEND_VESTING_ID"

echo ""
echo "▶ Deploying TlendAirdropContract…"
TLEND_AIRDROP_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/tlend_airdrop.wasm \
  --network "$NETWORK" \
  --source "$ADMIN_KEY")
echo "  ✔ TLEND_AIRDROP_CONTRACT_ID = $TLEND_AIRDROP_ID"

# ── Step 3: Wire contracts together ───────────────────────────────────────────

echo ""
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

# ── TLEND governance token + distribution (issue #107) ───────────────────────
# Decimals/name/symbol are fixed at init. TLEND_TOTAL_SUPPLY is minted to the
# admin, who then funds individual vesting schedules (via `create_vesting_schedule`)
# and the airdrop pool (via `fund`) out of that balance as needed.
TLEND_TOTAL_SUPPLY="${TLEND_TOTAL_SUPPLY:-1000000000000}" # 100M TLEND @ 7 decimals

echo ""
echo "▶ Initialising TlendTokenContract (TLEND, 7 decimals)…"
stellar contract invoke --id "$TLEND_TOKEN_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- initialize --admin "$ADMIN_ADDRESS" --decimals 7 --name "TrustLend" --symbol "TLEND"
stellar contract invoke --id "$TLEND_TOKEN_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- mint --to "$ADMIN_ADDRESS" --amount "$TLEND_TOTAL_SUPPLY"
echo "  ✔ Minted $TLEND_TOTAL_SUPPLY raw units of TLEND to $ADMIN_ADDRESS"

echo "▶ Initialising TlendVestingContract…"
stellar contract invoke --id "$TLEND_VESTING_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
  -- initialize --admin "$ADMIN_ADDRESS" --token "$TLEND_TOKEN_ID"
echo "  ℹ Create schedules later with \`create_vesting_schedule\` (admin, beneficiary,"
echo "    category, total_amount, terms) — each call escrows tokens from the admin."

# Airdrop needs a Merkle root of eligible (address, amount) leaves before it can
# be initialised — generate one off-chain and pass it in:
#   export TLEND_AIRDROP_MERKLE_ROOT=<64-char hex sha256 root>
if [ -n "${TLEND_AIRDROP_MERKLE_ROOT:-}" ]; then
  echo "▶ Initialising TlendAirdropContract…"
  stellar contract invoke --id "$TLEND_AIRDROP_ID" --source "$ADMIN_KEY" --network "$NETWORK" \
    -- initialize --admin "$ADMIN_ADDRESS" --token "$TLEND_TOKEN_ID" --merkle_root "$TLEND_AIRDROP_MERKLE_ROOT"
  echo "  ✔ Airdrop root set — fund the pool with the \`fund\` invocation before claims open"
else
  echo "ℹ Skipping TlendAirdropContract initialisation (set TLEND_AIRDROP_MERKLE_ROOT to enable)."
  echo "    Initialise later with: stellar contract invoke --id $TLEND_AIRDROP_ID ... -- initialize \\"
  echo "      --admin $ADMIN_ADDRESS --token $TLEND_TOKEN_ID --merkle_root <root>"
fi

echo ""
echo "✔ All contracts initialised"

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

stellar contract bindings typescript \
  --network "$NETWORK" \
  --id "$TLEND_AIRDROP_ID" \
  --output-dir "$BINDINGS_OUT/tlend_airdrop"

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
