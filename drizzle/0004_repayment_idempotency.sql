-- A Stellar payment can back at most one repayment, including concurrent retries.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_loan_repayments_tx_ref"
  ON "loan_repayments" ("tx_ref")
  WHERE "tx_ref" IS NOT NULL;