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

function Deploy-Contract([string]$name, [string]$wasmPath, [string[]]$ctorArgs = @()) {
    Write-Host "Deploying $name..."
    $maxRetries = 3
    $retryCount = 0
    while ($retryCount -lt $maxRetries) {
        try {
            $deployArgs = @("contract", "deploy", "--wasm", $wasmPath, "--network", $NETWORK, "--source", $ADMIN_KEY)
            if ($ctorArgs.Count -gt 0) {
                $deployArgs += "--"
                $deployArgs += $ctorArgs
            }
            $id = (stellar @deployArgs 2>&1 | Select-String "C[A-Z0-9]{55}").Matches.Value | Select-Object -Last 1
            if ([string]::IsNullOrWhiteSpace($id)) {
                # Fallback extraction if not outputting just the ID
                $output = stellar @deployArgs
                $id = $output.Trim()
            }
            if (![string]::IsNullOrWhiteSpace($id)) {
                Write-Host "Success: $id"
                return $id
            }
        } catch {
            Write-Host "Attempt $($retryCount + 1) failed: $_"
        }
        $retryCount++
        Start-Sleep -Seconds 5
    }
    throw "Failed to deploy $name after 3 attempts."
}

$MultisigSigners = if ($env:MULTISIG_SIGNERS) { $env:MULTISIG_SIGNERS } else { $ADMIN_ADDRESS }
$MultisigThreshold = if ($env:MULTISIG_THRESHOLD) { $env:MULTISIG_THRESHOLD } else { "1" }
$SignerArr = $MultisigSigners -split ","
$SignersJson = "[" + (($SignerArr | ForEach-Object { "`"$_`"" }) -join ",") + "]"

$REPUTATION_ID = Deploy-Contract "BorrowerReputation" "target/wasm32v1-none/release/borrower_reputation.wasm" @("--admin", $ADMIN_ADDRESS)
$ESCROW_ID = Deploy-Contract "Escrow" "target/wasm32v1-none/release/escrow.wasm" @("--admin", $ADMIN_ADDRESS)
$LENDING_ID = Deploy-Contract "Lending" "target/wasm32v1-none/release/lending.wasm" @("--admin", $ADMIN_ADDRESS)
$DEFAULT_ID = Deploy-Contract "DefaultManagement" "target/wasm32v1-none/release/default_management.wasm" @("--admin", $ADMIN_ADDRESS, "--initial_insurance_balance", "0")
$GOVERNANCE_ID = Deploy-Contract "Governance" "target/wasm32v1-none/release/governance.wasm" @("--admin", $ADMIN_ADDRESS, "--lending", $LENDING_ID, "--reputation", $REPUTATION_ID, "--voting_period_secs", "259200", "--quorum_votes", "500", "--min_proposer_power", "150", "--max_fee_bps", "1000")
$MULTISIG_ID = Deploy-Contract "MultiSigAdmin" "target/wasm32v1-none/release/multisig_admin.wasm" @("--signers", $SignersJson, "--threshold", $MultisigThreshold)

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
