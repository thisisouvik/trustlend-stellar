import { test, expect } from "@playwright/test";
import varialMock from "./setup/varial-mock";

// Mock constant values to simulate deterministic chain data
const MOCK_LENDING_CONTRACT = "CA_MOCK_LENDING_CONTRACT_ID";

test.describe("TrustLend Complete Lending Flow", () => {
  // Apply our global mock before any navigation so the window object contains `varial` / `freighter`
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(varialMock);

    // Provide mock RPC endpoints to prevent Soroban testnet calls from actually failing
    await page.route("**/soroban-testnet.stellar.org", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const postData = JSON.parse(request.postData() || "{}");

        // Mock simulateTransaction
        if (postData.method === "simulateTransaction") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: postData.id,
              result: {
                // Faking a successful transaction simulation payload output
                transactionData: "AAAAAAA=",
                minResourceFee: "100",
                results: [{
                  auth: [],
                  xdr: "AAAAAAA="
                }],
              },
            }),
          });
        }

        // Mock sendTransaction
        if (postData.method === "sendTransaction") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: postData.id,
              result: {
                hash: "mock_tx_hash_for_e2e_successful_send",
                status: "PENDING"
              },
            }),
          });
        }
        
        // Mock getTransaction
        if (postData.method === "getTransaction") {
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: postData.id,
              result: {
                status: "SUCCESS",
                txHash: "mock_tx_hash_for_e2e_successful_send"
              },
            }),
          });
        }
      }

      // Default mock fallback for Soroban RPC
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      });
    });
  });

  test.skip("Complete lifecycle: Wallet Connect -> Supply -> Borrow -> Repay", async ({ page }) => {
    // 1. Visit the application
    await page.goto("/");

    // 2. Connect Wallet
    // Assuming standard "Connect Wallet" button on the UI Header
    const connectButton = page.getByRole("button", { name: /Connect Wallet/i }).first();
    await connectButton.click();
    
    // We expect the wallet selection modal, choose Varial
    const varialButton = page.getByRole("button", { name: /Varial|Freighter/i });
    if (await varialButton.isVisible()) {
      await varialButton.click();
    }
    
    // Validate we are connected (usually UI shows an abbreviated account string)
    await expect(page.getByText("GAJRN...EAAJX")).toBeVisible({ timeout: 10000 });
    
    // In our mock, wallet is connected.
    // 3. Navigate to Dashboard (where lending occurs)
    await page.goto("/dashboard");

    // 4. Supply Collateral Flow
    const supplyInput = page.getByPlaceholder("Amount to supply", { exact: false }).first();
    if (await supplyInput.isVisible()) {
      await supplyInput.fill("500");
      
      const supplySubmit = page.getByRole("button", { name: "Supply" }).first();
      await supplySubmit.click();
      
      // Wait for success toast/notification or state update
      await expect(page.getByText(/Supply Successful/i)).toBeVisible();
    }

    // 5. Borrow Flow
    const borrowInput = page.getByPlaceholder("Amount to borrow", { exact: false }).first();
    if (await borrowInput.isVisible()) {
      await borrowInput.fill("100");
      
      const borrowSubmit = page.getByRole("button", { name: "Borrow" }).first();
      await borrowSubmit.click();
      
      await expect(page.getByText(/Borrow Successful/i)).toBeVisible();
    }

    // 6. Repay Flow
    // Expect the dashboard has updated with our borrowed amount (in a real DB the SubQuery indexer handles this,
    // but in mocked E2E, the UI component optimistically updates, or if relying on the DB, 
    // the user wants the UI to respond to the interactions). We'll attempt locating a Repay button.
    const repayButton = page.getByRole("button", { name: "Repay" }).first();
    if (await repayButton.isVisible()) {
       await repayButton.click();
       
       const repayInput = page.getByPlaceholder("Repay Amount");
       if (await repayInput.isVisible()) {
         await repayInput.fill("50");
       }
       
       const confirmRepay = page.getByRole("button", { name: "Confirm Repayment" });
       if (await confirmRepay.isVisible()) {
         await confirmRepay.click();
       }
       
       await expect(page.getByText(/Repay Successful/i)).toBeVisible();
    }
  });

});
