/**
 * lib/db/schema.ts
 *
 * Drizzle schema for the TrustLend Postgres database (Neon).
 *
 * This is the single source of truth for the relational model. Migrations are
 * generated from it with `npm run db:generate` and applied with
 * `npm run db:migrate` (see drizzle.config.ts and drizzle/).
 *
 * Identity: `users` replaces Supabase's `auth.users`. A user is a Stellar
 * wallet (SEP-10 sign-in); `profiles` holds the application-facing profile and
 * shares the user's id.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ─── Enums ────────────────────────────────────────────────────────────────────

export const appRoleEnum = pgEnum("app_role", ["borrower", "lender", "admin"]);
export const kycStatusEnum = pgEnum("kyc_status", ["pending", "submitted", "verified", "rejected"]);
export const riskStatusEnum = pgEnum("risk_status", ["low", "medium", "high", "blocked"]);
export const loanStatusEnum = pgEnum("loan_status", [
  "requested",
  "approved",
  "funded",
  "active",
  "repaid",
  "defaulted",
  "cancelled",
]);
export const poolStatusEnum = pgEnum("pool_status", ["active", "paused", "closed"]);
export const positionStatusEnum = pgEnum("position_status", ["active", "closed"]);
export const txStatusEnum = pgEnum("tx_status", ["pending", "confirmed", "failed", "cancelled"]);
export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "verified",
  "rejected",
  "expired",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "open",
  "assigned",
  "completed",
  "verified",
  "cancelled",
]);
export const taskDifficultyEnum = pgEnum("task_difficulty", ["easy", "medium", "hard"]);
export const riskDecisionEnum = pgEnum("risk_decision", ["allow", "manual_review", "reject"]);
export const rateModelEnum = pgEnum("rate_model", ["fixed", "floating"]);
export const referralStatusEnum = pgEnum("referral_status", [
  "pending",
  "qualified",
  "paid",
  "rejected",
]);

// ─── Shared column helpers ────────────────────────────────────────────────────

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 20, scale: 6 });

// ─── Identity ─────────────────────────────────────────────────────────────────

/** One row per Stellar wallet that has signed in. Replaces Supabase auth.users. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletAddress: text("wallet_address").notNull(),
    role: appRoleEnum("role").notNull().default("borrower"),
    email: text("email"),
    createdAt: createdAt(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_wallet_address_key").on(t.walletAddress)],
);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull().default(""),
    role: appRoleEnum("role").notNull().default("borrower"),
    walletAddress: text("wallet_address"),
    countryCode: text("country_code"),
    phone: text("phone"),
    dateOfBirth: date("date_of_birth"),
    kycStatus: kycStatusEnum("kyc_status").notNull().default("pending"),
    riskStatus: riskStatusEnum("risk_status").notNull().default("medium"),
    // KYC document + provider fields
    governmentIdIpfsHash: text("government_id_ipfs_hash"),
    governmentIdUrl: text("government_id_url"),
    kycSubmittedAt: timestamp("kyc_submitted_at", { withTimezone: true }),
    kycVerifiedAt: timestamp("kyc_verified_at", { withTimezone: true }),
    kycRejectionReason: text("kyc_rejection_reason"),
    kycProviderId: text("kyc_provider_id"),
    kycProviderStatus: text("kyc_provider_status"),
    regulatedPoolAccess: boolean("regulated_pool_access").notNull().default(false),
    referralCode: text("referral_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_profiles_role").on(t.role),
    index("idx_profiles_wallet_address").on(t.walletAddress),
    index("idx_profiles_kyc_status").on(t.kycStatus),
    index("idx_profiles_risk_status").on(t.riskStatus),
    index("idx_profiles_kyc_submitted_at").on(t.kycSubmittedAt),
    uniqueIndex("profiles_referral_code_key").on(t.referralCode),
    uniqueIndex("idx_profiles_kyc_provider_id")
      .on(t.kycProviderId)
      .where(sql`${t.kycProviderId} is not null`),
    index("idx_profiles_regulated_pool_access").on(t.regulatedPoolAccess),
  ],
);

// ─── Reputation ───────────────────────────────────────────────────────────────

export const reputationEvents = pgTable(
  "reputation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id"),
    sourceKey: text("source_key"),
    pointsDelta: integer("points_delta").notNull(),
    reason: text("reason").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_rep_events_user_id_created_at").on(t.userId, t.createdAt),
    index("idx_rep_events_source").on(t.sourceType, t.sourceId),
    index("idx_rep_events_source_key").on(t.sourceType, t.sourceKey),
  ],
);

export const reputationSnapshots = pgTable("reputation_snapshots", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  scoreTotal: integer("score_total").notNull().default(0),
  repaymentScore: integer("repayment_score").notNull().default(0),
  lendingScore: integer("lending_score").notNull().default(0),
  consistencyScore: integer("consistency_score").notNull().default(0),
  externalScore: integer("external_score").notNull().default(0),
  reputationLevel: text("reputation_level").notNull().default("bronze"),
  /** Per-factor breakdown from the last daily recalculation (lib/reputation/scoring). */
  scoreBreakdown: jsonb("score_breakdown").notNull().default(sql`'{}'::jsonb`),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: updatedAt(),
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    assignedTo: uuid("assigned_to").references(() => profiles.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),
    rewardXlm: money("reward_xlm").notNull().default("0"),
    difficulty: taskDifficultyEnum("difficulty").notNull().default("easy"),
    status: taskStatusEnum("status").notNull().default("open"),
    completionDeadline: timestamp("completion_deadline", { withTimezone: true }),
    completionDate: timestamp("completion_date", { withTimezone: true }),
    proofSubmission: text("proof_submission"),
    creatorRating: smallint("creator_rating"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_tasks_creator_id").on(t.creatorId),
    index("idx_tasks_assigned_to").on(t.assignedTo),
    index("idx_tasks_status").on(t.status),
    index("idx_tasks_created_at").on(t.createdAt),
  ],
);

// ─── Lending pools and positions ──────────────────────────────────────────────

export const lendingPools = pgTable(
  "lending_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: poolStatusEnum("status").notNull().default("active"),
    currency: text("currency").notNull().default("XLM"),
    aprBps: integer("apr_bps").notNull(),
    totalLiquidity: money("total_liquidity").notNull().default("0"),
    availableLiquidity: money("available_liquidity").notNull().default("0"),
    totalBorrowed: money("total_borrowed").notNull().default("0"),
    /** Max total principal this pool may lend out (null = unlimited). */
    borrowCap: numeric("borrow_cap", { precision: 20, scale: 7 }),
    /** Pool id on the PooledLendingContract; null until mirrored on-chain. */
    onchainPoolId: integer("onchain_pool_id"),
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_lending_pools_status").on(t.status),
    index("idx_lending_pools_status_available").on(t.status, t.availableLiquidity),
    index("idx_lending_pools_created_at_desc").on(t.createdAt),
  ],
);

export const poolPositions = pgTable(
  "pool_positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => lendingPools.id, { onDelete: "cascade" }),
    lenderId: uuid("lender_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    status: positionStatusEnum("status").notNull().default("active"),
    principalAmount: money("principal_amount").notNull(),
    earnedInterest: money("earned_interest").notNull().default("0"),
    withdrawnAmount: money("withdrawn_amount").notNull().default("0"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_pool_positions_lender_id").on(t.lenderId),
    index("idx_pool_positions_pool_id").on(t.poolId),
  ],
);

// ─── Loans ────────────────────────────────────────────────────────────────────

export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    borrowerId: uuid("borrower_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    /** Null for loans funded directly by lenders on the marketplace. */
    poolId: uuid("pool_id").references(() => lendingPools.id, { onDelete: "restrict" }),
    status: loanStatusEnum("status").notNull().default("requested"),
    principalAmount: money("principal_amount").notNull(),
    aprBps: integer("apr_bps").notNull(),
    durationDays: integer("duration_days").notNull(),
    /** "fixed" | "floating" — mirrors the on-chain InterestRateModel. */
    rateModel: text("rate_model").notNull().default("fixed"),
    rateSwitchCount: integer("rate_switch_count").notNull().default(0),
    lastRateSwitchAt: timestamp("last_rate_switch_at", { withTimezone: true }),
    /** Running total of partial fills (issue #269). */
    fundedAmount: money("funded_amount").notNull().default("0"),
    repaidAmount: money("repaid_amount").notNull().default("0"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    fundedAt: timestamp("funded_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    defaultedAt: timestamp("defaulted_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_loans_borrower_id").on(t.borrowerId),
    index("idx_loans_pool_id").on(t.poolId),
    index("idx_loans_status").on(t.status),
    index("idx_loans_due_at").on(t.dueAt),
    index("idx_loans_borrower_status").on(t.borrowerId, t.status),
    index("idx_loans_rate_model").on(t.rateModel),
    index("idx_loans_status_funded").on(t.status, t.fundedAmount),
  ],
);

export const loanRepayments = pgTable(
  "loan_repayments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    txRef: text("tx_ref"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_loan_repayments_loan_id").on(t.loanId),
    index("idx_loan_repayments_payer_id").on(t.payerId),
  ],
);

/** Individual lender contributions to a loan (partial fills, issue #269). */
export const loanFundings = pgTable(
  "loan_fundings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    loanId: uuid("loan_id")
      .notNull()
      .references(() => loans.id, { onDelete: "cascade" }),
    lenderId: uuid("lender_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    txHash: text("tx_hash").notNull(),
    lenderAddress: text("lender_address"),
    fundedAt: timestamp("funded_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index("idx_loan_fundings_loan_id").on(t.loanId),
    index("idx_loan_fundings_lender_id").on(t.lenderId),
    index("idx_loan_fundings_lender_loan").on(t.lenderId, t.loanId),
    uniqueIndex("idx_loan_fundings_tx_hash").on(t.txHash),
  ],
);

// ─── Interest rate configuration (issue #321) ─────────────────────────────────

/**
 * Admin-tunable APR schedule, one active row per rate model.
 *
 * Replaces the hardcoded APR ladder that used to live in
 * app/api/loans/apply/route.ts so rates can track market conditions without a
 * deployment. Rows are append-only and versioned: publishing a new schedule
 * deactivates the previous row rather than mutating it, which keeps the exact
 * numbers a loan was priced against readable forever (loans store the version
 * they were quoted under in `loans.metadata.rate_config_version`).
 *
 * `amountTiers` is an ordered ladder of `{ minAmount, aprBps }` — the pricing
 * code picks the highest `minAmount` the principal clears, so larger loans can
 * be rewarded with cheaper money. `reputationTiers` is an ordered ladder of
 * `{ minScore, multiplierBps }` applied to that APR (10000 = 1.00x), so a
 * trusted borrower pays less than a new one on the same principal.
 * See lib/loans/rate-config.ts for the shapes and the resolution order.
 */
export const interestRateConfigs = pgTable(
  "interest_rate_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rateModel: rateModelEnum("rate_model").notNull(),
    /** Monotonically increasing per rate model; quoted loans record this. */
    version: integer("version").notNull().default(1),
    /** Only one row per rate model may be active at a time. */
    isActive: boolean("is_active").notNull().default(true),
    /** APR floor in bps used when no amount tier matches (e.g. 1500 = 15%). */
    baseAprBps: integer("base_apr_bps").notNull(),
    /** Hard clamps applied after tiers and multipliers, in bps. */
    minAprBps: integer("min_apr_bps").notNull().default(0),
    maxAprBps: integer("max_apr_bps").notNull().default(10000),
    /** Ordered `{ minAmount, aprBps }[]` ladder, cheapest-for-largest. */
    amountTiers: jsonb("amount_tiers").notNull().default(sql`'[]'::jsonb`),
    /** Ordered `{ minScore, multiplierBps }[]` ladder; 10000 = 1.00x. */
    reputationTiers: jsonb("reputation_tiers").notNull().default(sql`'[]'::jsonb`),
    /** Why this schedule was published — shown in the admin audit trail. */
    notes: text("notes"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    /** Email captured at publish time so history survives user deletion. */
    updatedByEmail: text("updated_by_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("interest_rate_configs_model_version_key").on(t.rateModel, t.version),
    uniqueIndex("interest_rate_configs_active_model_key")
      .on(t.rateModel)
      .where(sql`${t.isActive}`),
    index("idx_interest_rate_configs_model_created_at").on(t.rateModel, t.createdAt),
  ],
);

// ─── Platform Settings ────────────────────────────────────────────────────────

export const platformSettings = pgTable(
  "platform_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    settingKey: text("setting_key").notNull(),
    valueBps: integer("value_bps").notNull(),
    version: integer("version").notNull().default(1),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedByEmail: text("updated_by_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("platform_settings_key_version_key").on(t.settingKey, t.version),
    uniqueIndex("platform_settings_active_key")
      .on(t.settingKey)
      .where(sql`${t.isActive}`),
    index("idx_platform_settings_created_at").on(t.createdAt),
  ],
);

// ─── Risk and fraud ───────────────────────────────────────────────────────────

export const riskAssessments = pgTable(
  "risk_assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    decision: riskDecisionEnum("decision").notNull(),
    reasons: jsonb("reasons").notNull().default(sql`'[]'::jsonb`),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("idx_risk_assessments_user_id_assessed_at").on(t.userId, t.assessedAt)],
);

export const fraudSignals = pgTable(
  "fraud_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    signalType: text("signal_type").notNull(),
    severity: smallint("severity").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_fraud_signals_user_id_created_at").on(t.userId, t.createdAt),
    index("idx_fraud_signals_resolved").on(t.resolved),
  ],
);

// ─── Ledger and chain mapping ─────────────────────────────────────────────────

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("XLM"),
    status: txStatusEnum("status").notNull().default("pending"),
    refType: text("ref_type"),
    refId: uuid("ref_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_ledger_transactions_user_id_created_at").on(t.userId, t.createdAt),
    index("idx_ledger_transactions_status").on(t.status),
  ],
);

export const chainEvents = pgTable(
  "chain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    txHash: text("tx_hash").notNull(),
    contractId: text("contract_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    happenedAt: timestamp("happened_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chain_events_tx_hash_event_type_key").on(t.txHash, t.eventType),
    index("idx_chain_events_contract_id").on(t.contractId),
    index("idx_chain_events_happened_at").on(t.happenedAt),
  ],
);

// ─── External verification ────────────────────────────────────────────────────

export const externalVerifications = pgTable(
  "external_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    verificationType: text("verification_type").notNull(),
    status: verificationStatusEnum("status").notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    payloadMeta: jsonb("payload_meta").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_external_verifications_user_id").on(t.userId),
    index("idx_external_verifications_status").on(t.status),
  ],
);

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** "discord" | "telegram" | "slack" | "custom" */
    platform: text("platform").notNull(),
    topic: text("topic").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_webhook_endpoints_platform").on(t.platform),
    index("idx_webhook_endpoints_topic").on(t.topic),
  ],
);

// ─── Referrals ────────────────────────────────────────────────────────────────

export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: uuid("referrer_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    refereeId: uuid("referee_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    referralCode: text("referral_code").notNull(),
    status: referralStatusEnum("status").notNull().default("pending"),
    qualifyingLoanId: uuid("qualifying_loan_id").references(() => loans.id, {
      onDelete: "set null",
    }),
    /** Bonus as reported by the contract, in whole reward tokens. */
    bonusAmount: numeric("bonus_amount", { precision: 20, scale: 7 }).notNull().default("0"),
    /** Stellar transaction that carried the payout. */
    payoutTxHash: text("payout_tx_hash"),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("referrals_referee_id_key").on(t.refereeId),
    index("idx_referrals_referrer_id").on(t.referrerId),
    index("idx_referrals_status").on(t.status),
    index("idx_referrals_referrer_status").on(t.referrerId, t.status),
  ],
);

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("idx_notifications_user_id_created_at").on(t.userId, t.createdAt)],
);

// ─── Relations (for db.query.* relational API) ───────────────────────────────

export const usersRelations = relations(users, ({ one }) => ({
  profile: one(profiles, { fields: [users.id], references: [profiles.id] }),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  user: one(users, { fields: [profiles.id], references: [users.id] }),
  loans: many(loans),
  poolPositions: many(poolPositions),
  ledgerTransactions: many(ledgerTransactions),
  reputationEvents: many(reputationEvents),
  reputationSnapshot: one(reputationSnapshots, {
    fields: [profiles.id],
    references: [reputationSnapshots.userId],
  }),
}));

export const loansRelations = relations(loans, ({ one, many }) => ({
  borrower: one(profiles, { fields: [loans.borrowerId], references: [profiles.id] }),
  pool: one(lendingPools, { fields: [loans.poolId], references: [lendingPools.id] }),
  repayments: many(loanRepayments),
  fundings: many(loanFundings),
}));

export const loanRepaymentsRelations = relations(loanRepayments, ({ one }) => ({
  loan: one(loans, { fields: [loanRepayments.loanId], references: [loans.id] }),
  payer: one(profiles, { fields: [loanRepayments.payerId], references: [profiles.id] }),
}));

export const loanFundingsRelations = relations(loanFundings, ({ one }) => ({
  loan: one(loans, { fields: [loanFundings.loanId], references: [loans.id] }),
  lender: one(profiles, { fields: [loanFundings.lenderId], references: [profiles.id] }),
}));

export const lendingPoolsRelations = relations(lendingPools, ({ many }) => ({
  positions: many(poolPositions),
  loans: many(loans),
}));

export const poolPositionsRelations = relations(poolPositions, ({ one }) => ({
  pool: one(lendingPools, { fields: [poolPositions.poolId], references: [lendingPools.id] }),
  lender: one(profiles, { fields: [poolPositions.lenderId], references: [profiles.id] }),
}));

export const ledgerTransactionsRelations = relations(ledgerTransactions, ({ one }) => ({
  user: one(profiles, { fields: [ledgerTransactions.userId], references: [profiles.id] }),
}));

export const reputationEventsRelations = relations(reputationEvents, ({ one }) => ({
  user: one(profiles, { fields: [reputationEvents.userId], references: [profiles.id] }),
}));

export const referralsRelations = relations(referrals, ({ one }) => ({
  referrer: one(profiles, { fields: [referrals.referrerId], references: [profiles.id] }),
  referee: one(profiles, { fields: [referrals.refereeId], references: [profiles.id] }),
  qualifyingLoan: one(loans, { fields: [referrals.qualifyingLoanId], references: [loans.id] }),
}));

// ─── Row types ────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type Loan = typeof loans.$inferSelect;
export type LoanRepayment = typeof loanRepayments.$inferSelect;
export type LoanFunding = typeof loanFundings.$inferSelect;
export type LendingPool = typeof lendingPools.$inferSelect;
export type PoolPosition = typeof poolPositions.$inferSelect;
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;
export type ReputationEvent = typeof reputationEvents.$inferSelect;
export type ReputationSnapshot = typeof reputationSnapshots.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type Referral = typeof referrals.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type FraudSignal = typeof fraudSignals.$inferSelect;
export type RiskAssessment = typeof riskAssessments.$inferSelect;
export type InterestRateConfigRow = typeof interestRateConfigs.$inferSelect;
export type PlatformSettingRow = typeof platformSettings.$inferSelect;
