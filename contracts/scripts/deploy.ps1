# =============================================================================
# SUPERSEDED by `npm run deploy:testnet` (issue #270).
#
# The Node CLI at scripts/deploy-testnet.ts is cross-platform, so this script
# and deploy.sh no longer have to be kept in sync by hand. It also creates and
# funds the admin key for you, deploys the pooled_lending contract this script
# omits, and writes the contract IDs into .env.local directly.
#
#   npm run deploy:testnet            # deploy everything
#   npm run deploy:testnet:dry        # preview without touching the network
#   npm run deploy:testnet -- --help  # all options
#
# Kept for now so existing muscle memory and CI jobs keep working.
# =============================================================================
$ErrorActionPreference = "Stop"
$NETWORK = "testnet"
$ADMIN_KEY = "trustlend-admin"
$ADMIN_ADDRESS = (stellar keys address $ADMIN_KEY).Trim()

Write-Host "Admin Address: $ADMIN_ADDRESS"

# Every contract initialises in its Soroban constructor, whose arguments are
# passed after `--` on `stellar contract deploy` (issue #352). Deployment and
# initialisation are one atomic transaction, so there is no window in which a
# contract is live but uninitialised and an observer could front-run
# `initialize` to claim admin rights. Contracts whose constructors take another
# contract's id are deployed after it.
function Deploy-Contract([string]$name, [string]$wasmPath, [string[]]$constructorArgs) {
    Write-Host "Deploying $name (initialized by constructor)..."
    $maxRetries = 3
    $retryCount = 0
    while ($retryCount -lt $maxRetries) {
        try {
            $output = stellar contract deploy --wasm $wasmPath --network $NETWORK --source $ADMIN_KEY -- @constructorArgs 2>&1
            $id = ($output | Select-String "C[A-Z0-9]{55}").Matches.Value | Select-Object -Last 1
            if (![string]::IsNullOrWhiteSpace($id)) {
                Write-Host "Success: $id"
                return $id
            }
            Write-Host "Attempt $($retryCount + 1) returned no contract id: $output"
        } catch {
            Write-Host "Attempt $($retryCount + 1) failed: $_"
        }
        $retryCount++
        Start-Sleep -Seconds 5
    }
    throw "Failed to deploy $name after 3 attempts."
}

# Multi-Sig Admin (issue #73): comma-separated signers + threshold. Defaults
# to a 1-of-1 multisig using the deploying admin alone.
#   $env:MULTISIG_SIGNERS = "G...,G...,G..."
#   $env:MULTISIG_THRESHOLD = "2"
$MultisigSigners = if ($env:MULTISIG_SIGNERS) { $env:MULTISIG_SIGNERS } else { $ADMIN_ADDRESS }
$MultisigThreshold = if ($env:MULTISIG_THRESHOLD) { $env:MULTISIG_THRESHOLD } else { "1" }
$SignerArr = $MultisigSigners -split ","
$SignersJson = "[" + (($SignerArr | ForEach-Object { "`"$_`"" }) -join ",") + "]"

$REPUTATION_ID = Deploy-Contract "BorrowerReputation" "target/wasm32v1-none/release/borrower_reputation.wasm" @("--admin", $ADMIN_ADDRESS)
$ESCROW_ID = Deploy-Contract "Escrow" "target/wasm32v1-none/release/escrow.wasm" @("--admin", $ADMIN_ADDRESS)
$LENDING_ID = Deploy-Contract "Lending" "target/wasm32v1-none/release/lending.wasm" @("--admin", $ADMIN_ADDRESS)
$DEFAULT_ID = Deploy-Contract "DefaultManagement" "target/wasm32v1-none/release/default_management.wasm" @("--admin", $ADMIN_ADDRESS, "--initial_insurance_balance", "0")
$GOVERNANCE_ID = Deploy-Contract "Governance" "target/wasm32v1-none/release/governance.wasm" @(
    "--admin", $ADMIN_ADDRESS,
    "--lending", $LENDING_ID,
    "--reputation", $REPUTATION_ID,
    "--voting_period_secs", "259200",
    "--quorum_votes", "500",
    "--min_proposer_power", "150",
    "--max_fee_bps", "1000"
)
Write-Host "MultiSigAdmin: $MultisigThreshold-of-$($SignerArr.Count)"
$MULTISIG_ID = Deploy-Contract "MultiSigAdmin" "target/wasm32v1-none/release/multisig_admin.wasm" @("--signers", $SignersJson, "--threshold", $MultisigThreshold)

# ── Post-deploy wiring (contracts are already initialised) ──

# Escrow takes custody of lender funds and only accepts allowlisted tokens
# (Issue #417). Allow the native XLM Stellar Asset Contract.
$XLM_SAC_ID = stellar contract id asset --asset native --network $NETWORK
Write-Host "Allowing native XLM ($XLM_SAC_ID) for escrow holds..."
stellar contract invoke --id $ESCROW_ID --source $ADMIN_KEY --network $NETWORK -- set_allowed_token --caller $ADMIN_ADDRESS --token $XLM_SAC_ID --allowed true

# Lending reads every borrower's tier and credit limit from the reputation
# contract (Issue #335); loan requests are rejected until this link exists.
Write-Host "Linking Lending -> Reputation..."
stellar contract invoke --id $LENDING_ID --source $ADMIN_KEY --network $NETWORK -- set_reputation_contract --admin $ADMIN_ADDRESS --reputation $REPUTATION_ID

Write-Host "Linking MultiSigAdmin to Lending, Default Management, Reputation..."
stellar contract invoke --id $LENDING_ID --source $ADMIN_KEY --network $NETWORK -- set_multisig_admin --admin $ADMIN_ADDRESS --multisig $MULTISIG_ID
stellar contract invoke --id $DEFAULT_ID --source $ADMIN_KEY --network $NETWORK -- set_multisig_admin --admin $ADMIN_ADDRESS --multisig $MULTISIG_ID
stellar contract invoke --id $REPUTATION_ID --source $ADMIN_KEY --network $NETWORK -- set_multisig_admin --admin $ADMIN_ADDRESS --multisig $MULTISIG_ID

Write-Host "Proposing + executing SetGovernance (Lending <- Governance) via multisig..."
$GovAction = "{`"SetGovernance`":[`"$LENDING_ID`",`"$GOVERNANCE_ID`"]}"
$GovProposalId = (stellar contract invoke --id $MULTISIG_ID --source $ADMIN_KEY --network $NETWORK -- propose --proposer $ADMIN_ADDRESS --action $GovAction).Trim()
stellar contract invoke --id $MULTISIG_ID --source $ADMIN_KEY --network $NETWORK -- execute --proposal_id $GovProposalId
Write-Host "Governance linked (only votes can change the fee now)."

# Optional: register the Credit Oracle via multisig propose+execute
# (set_oracle is multisig-gated). Set $env:ORACLE_ADDRESS to enable.
if ($env:ORACLE_ADDRESS) {
    Write-Host "Proposing + executing SetOracle ($env:ORACLE_ADDRESS) via multisig..."
    $OracleAction = "{`"SetOracle`":[`"$REPUTATION_ID`",`"$env:ORACLE_ADDRESS`"]}"
    $OracleProposalId = (stellar contract invoke --id $MULTISIG_ID --source $ADMIN_KEY --network $NETWORK -- propose --proposer $ADMIN_ADDRESS --action $OracleAction).Trim()
    stellar contract invoke --id $MULTISIG_ID --source $ADMIN_KEY --network $NETWORK -- execute --proposal_id $OracleProposalId
} else {
    Write-Host "Skipping oracle registration (set `$env:ORACLE_ADDRESS to enable)."
}

$envFile = @"
# ── Soroban Contract IDs ──
NEXT_PUBLIC_REPUTATION_CONTRACT_ID=$REPUTATION_ID
NEXT_PUBLIC_ESCROW_CONTRACT_ID=$ESCROW_ID
NEXT_PUBLIC_LENDING_CONTRACT_ID=$LENDING_ID
NEXT_PUBLIC_DEFAULT_CONTRACT_ID=$DEFAULT_ID
NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_ID
NEXT_PUBLIC_MULTISIG_ADMIN_CONTRACT_ID=$MULTISIG_ID
NEXT_PUBLIC_ADMIN_ADDRESS=$ADMIN_ADDRESS
NEXT_PUBLIC_ORACLE_ADDRESS=$env:ORACLE_ADDRESS
"@
$envFile | Out-File -FilePath ../.env.contracts -Encoding utf8
Write-Host "Saved to .env.contracts!"

# Now generate TS bindings
Write-Host "Generating testnet bindings..."
New-Item -ItemType Directory -Force -Path ../lib/contracts/generated | Out-Null
stellar contract bindings typescript --network $NETWORK --id $REPUTATION_ID --output-dir ../lib/contracts/generated/reputation
stellar contract bindings typescript --network $NETWORK --id $ESCROW_ID --output-dir ../lib/contracts/generated/escrow
stellar contract bindings typescript --network $NETWORK --id $LENDING_ID --output-dir ../lib/contracts/generated/lending
stellar contract bindings typescript --network $NETWORK --id $DEFAULT_ID --output-dir ../lib/contracts/generated/default_management
stellar contract bindings typescript --network $NETWORK --id $GOVERNANCE_ID --output-dir ../lib/contracts/generated/governance
stellar contract bindings typescript --network $NETWORK --id $MULTISIG_ID --output-dir ../lib/contracts/generated/multisig_admin

Write-Host "Deployment Pipeline Completed successfully."
