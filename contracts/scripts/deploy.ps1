$ErrorActionPreference = "Stop"
$NETWORK = "testnet"
$ADMIN_KEY = "trustlend-admin"
$ADMIN_ADDRESS = (stellar keys address $ADMIN_KEY).Trim()

Write-Host "Admin Address: $ADMIN_ADDRESS"

function Deploy-Contract([string]$name, [string]$wasmPath) {
    Write-Host "Deploying $name..."
    $maxRetries = 3
    $retryCount = 0
    while ($retryCount -lt $maxRetries) {
        try {
            $id = (stellar contract deploy --wasm $wasmPath --network $NETWORK --source $ADMIN_KEY 2>&1 | Select-String "C[A-Z0-9]{55}").Matches.Value | Select-Object -Last 1
            if ([string]::IsNullOrWhiteSpace($id)) {
                # Fallback extraction if not outputting just the ID
                $output = stellar contract deploy --wasm $wasmPath --network $NETWORK --source $ADMIN_KEY
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

$REPUTATION_ID = Deploy-Contract "BorrowerReputation" "target/wasm32v1-none/release/borrower_reputation.wasm"
$ESCROW_ID = Deploy-Contract "Escrow" "target/wasm32v1-none/release/escrow.wasm"
$LENDING_ID = Deploy-Contract "Lending" "target/wasm32v1-none/release/lending.wasm"
$DEFAULT_ID = Deploy-Contract "DefaultManagement" "target/wasm32v1-none/release/default_management.wasm"

Write-Host "Initializing Reputation..."
stellar contract invoke --id $REPUTATION_ID --source $ADMIN_KEY --network $NETWORK -- initialize --admin $ADMIN_ADDRESS

Write-Host "Initializing Escrow..."
stellar contract invoke --id $ESCROW_ID --source $ADMIN_KEY --network $NETWORK -- initialize --admin $ADMIN_ADDRESS

Write-Host "Initializing Lending..."
stellar contract invoke --id $LENDING_ID --source $ADMIN_KEY --network $NETWORK -- initialize --admin $ADMIN_ADDRESS

Write-Host "Initializing Default Management..."
stellar contract invoke --id $DEFAULT_ID --source $ADMIN_KEY --network $NETWORK -- initialize --admin $ADMIN_ADDRESS --initial_insurance_balance 0

$envFile = @"
# ── Soroban Contract IDs ──
NEXT_PUBLIC_REPUTATION_CONTRACT_ID=$REPUTATION_ID
NEXT_PUBLIC_ESCROW_CONTRACT_ID=$ESCROW_ID
NEXT_PUBLIC_LENDING_CONTRACT_ID=$LENDING_ID
NEXT_PUBLIC_DEFAULT_CONTRACT_ID=$DEFAULT_ID
NEXT_PUBLIC_ADMIN_ADDRESS=$ADMIN_ADDRESS
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

Write-Host "Deployment Pipeline Completed successfully."
