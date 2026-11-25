CREATE UNIQUE INDEX "idx_ledger_withdrawal_idempotency"
  ON "ledger_transactions" ("user_id", ("metadata"->>'withdrawalIdempotencyKey'))
  WHERE "category" = 'withdrawal' AND "metadata" ? 'withdrawalIdempotencyKey';
