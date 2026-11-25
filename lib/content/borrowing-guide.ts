/**
 * Content for the borrowing user guide and FAQ (Issue #265).
 *
 * Kept as data rather than JSX so the copy can be reviewed, searched and
 * tested independently of the page that renders it — the same approach as
 * `landing-content.ts`.
 *
 * IMPORTANT: every number quoted here is mirrored from the on-chain contract
 * or the keeper. The constants below are re-exported from the modules that own
 * them wherever possible, and the ones that live in Rust are restated with a
 * pointer to their source so a drift is easy to spot in review. If you change
 * a threshold in the contract, update this file in the same PR.
 */

import {
  HF_SAFE_THRESHOLD,
  HF_WARNING_THRESHOLD,
} from "@/lib/dashboard/health-factor";
import { RATE_SWITCH_FEE_BPS } from "@/lib/dashboard/interest-rates";

// ─── Protocol constants mirrored from the Soroban contract ──────────────────
// Source: contracts/lending/src/lib.rs

/** `DEFAULT_COLLATERAL_FACTOR_BPS` — assets without explicit config allow 75% LTV. */
export const DEFAULT_COLLATERAL_FACTOR_BPS = 7500;

/** `calculate_liquidation_threshold` — base threshold before adjustments. */
export const BASE_LIQUIDATION_THRESHOLD_BPS = 7500;

/** Lower clamp applied to the dynamic liquidation threshold. */
export const MIN_LIQUIDATION_THRESHOLD_BPS = 5000;

/** Upper clamp applied to the dynamic liquidation threshold. */
export const MAX_LIQUIDATION_THRESHOLD_BPS = 9000;

/** `DEFAULT_GRACE_PERIOD_DAYS` in lib/scheduler/default-management.ts. */
export const DEFAULT_GRACE_PERIOD_DAYS = 7;

export { HF_SAFE_THRESHOLD, HF_WARNING_THRESHOLD };

/**
 * Fee charged when switching between Fixed and Floating, in bps of debt.
 * Re-exported from the module that owns it so the documented figure cannot
 * drift away from the one the app actually charges.
 */
export { RATE_SWITCH_FEE_BPS };

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GuideStep {
  /** Zero-padded ordinal shown in the step marker, e.g. "01". */
  step: string;
  title: string;
  /** One-paragraph summary of what happens at this stage. */
  description: string;
  /** Concrete sub-points: what the borrower does, or what the protocol does. */
  details: string[];
  /** Optional in-app destination for this step. */
  href?: string;
  hrefLabel?: string;
}

export interface RiskLevel {
  /** Health Factor band label, e.g. "Above 1.5". */
  range: string;
  status: string;
  /** Hex colour, matching getHealthFactorColor() zones. */
  color: string;
  meaning: string;
  action: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
  /** Groups questions under a heading in the FAQ section. */
  category: "Basics" | "Collateral & Risk" | "Repayment" | "Costs & Rates";
}

// ─── Step-by-step borrowing process ─────────────────────────────────────────

export const borrowingSteps: GuideStep[] = [
  {
    step: "01",
    title: "Create your account and connect a Stellar wallet",
    description:
      "Sign in as a Borrower, then connect a Stellar wallet. The wallet is the address that will receive your loan and sign every on-chain action, so it must be connected before you can request funds.",
    details: [
      "Sign in with your Stellar wallet and choose the Borrower role.",
      "Connect a supported Stellar wallet (Varial, Albedo or xBull).",
      "Loans cannot be funded to an account with no wallet — the marketplace shows a 'No wallet' badge to lenders until you connect one.",
    ],
    href: "/dashboard/borrower/profile",
    hrefLabel: "Profile & Settings",
  },
  {
    step: "02",
    title: "Build a trust score",
    description:
      "TrustLend prices your loan on reputation, not just collateral. Your trust score runs from 0 to 750 and directly raises the LTV you are allowed to reach before liquidation.",
    details: [
      "New accounts start from a baseline score and earn more through verified activity and on-time repayment.",
      "A higher score raises your personal liquidation threshold — see 'How your liquidation threshold is set' below.",
      "Lenders see your score on every marketplace listing, so it also affects how quickly you get funded.",
    ],
    href: "/dashboard/borrower/tasks",
    hrefLabel: "Trust Tasks",
  },
  {
    step: "03",
    title: "Deposit collateral",
    description:
      "Collateralized borrowing means you lock an asset up front. The protocol values that asset and lets you borrow a fraction of its worth — never the whole amount, so there is a buffer if the price falls.",
    details: [
      "Collateral is transferred to the lending contract and held until the loan is repaid.",
      `By default an asset supports borrowing up to ${DEFAULT_COLLATERAL_FACTOR_BPS / 100}% of its value; admins can configure a different collateral factor per asset.`,
      "Only whitelisted assets can be used as collateral. Assets the keeper cannot price are never liquidated — but they also cannot back a loan.",
      "You can add more collateral later to improve your position. Withdrawals are allowed only while your remaining borrowing power still covers your active debt — the contract rejects any withdrawal that would leave a loan under-collateralized.",
    ],
  },
  {
    step: "04",
    title: "Submit a loan request",
    description:
      "Choose how much you want, for how long, and which interest rate model you prefer. The request is created on-chain with status Pending and is listed for lenders.",
    details: [
      "Pick an amount, a duration (30, 60 or 90 days) and the collateral you are posting.",
      "Choose Fixed (rate locked at creation) or Floating (moves with pool utilization, starts lower).",
      "Your request appears in the lender marketplace with your trust score, amount, APR and duration.",
    ],
    href: "/dashboard/borrower/loans",
    hrefLabel: "Apply for Loan",
  },
  {
    step: "05",
    title: "Get funded",
    description:
      "Lenders fund your request from the marketplace. A loan can be filled by one lender or by several taking smaller slices, so funding may arrive in stages.",
    details: [
      "The loan moves Pending → Approved as lenders commit capital.",
      "Partial funding is normal: the marketplace shows a progress bar, and other lenders can top it up.",
      "Once activated the loan becomes Active, the funds reach your wallet, and the repayment clock starts.",
    ],
  },
  {
    step: "06",
    title: "Repay before the due date",
    description:
      "Repay in full or in instalments at any time before maturity. Every payment reduces your outstanding balance immediately and improves your Health Factor.",
    details: [
      "Partial repayments are supported — each one is recorded on-chain and lowers your remaining balance.",
      "When the balance reaches zero the loan is marked Repaid and the collateral that was backing it is no longer locked.",
      "Withdrawing collateral is a separate action you take yourself. The contract only allows it while your remaining borrowing power still covers any other active debt.",
      "Repaying on time is what grows your trust score and unlocks better terms on the next loan.",
    ],
    href: "/dashboard/borrower/repay",
    hrefLabel: "Repay Loan",
  },
];

// ─── Liquidation risk bands (mirrors getHealthFactorZone) ───────────────────

export const healthFactorBands: RiskLevel[] = [
  {
    range: `Above ${HF_SAFE_THRESHOLD.toFixed(1)}`,
    status: "Safe",
    color: "var(--accent)",
    meaning:
      "Your collateral comfortably covers your debt. A normal price swing will not put you at risk.",
    action: "No action needed. Keep an eye on it if the market is volatile.",
  },
  {
    range: `${HF_WARNING_THRESHOLD.toFixed(1)} – ${HF_SAFE_THRESHOLD.toFixed(1)}`,
    status: "Warning — Low Buffer",
    color: "var(--warning)",
    meaning:
      "Your buffer is thin. A further drop in the value of your collateral could push you into liquidation.",
    action:
      "Add collateral or make a partial repayment now, while you still control the outcome.",
  },
  {
    range: `Below ${HF_WARNING_THRESHOLD.toFixed(1)}`,
    status: "Critical — Liquidation Risk",
    color: "var(--danger)",
    meaning:
      "You are close to, or already past, the point where the protocol can liquidate your position.",
    action:
      "Act immediately. Once the keeper liquidates there is no way to undo it.",
  },
];

// ─── Liquidation explainer ──────────────────────────────────────────────────

export const liquidationFacts: string[] = [
  "A bot checks every open loan roughly once a minute — liquidation is automatic and does not wait for a human to review your position.",
  "It compares your Loan-to-Value against a threshold calculated for you personally, and liquidates as soon as your LTV reaches or exceeds it.",
  "The check uses on-chain state and market prices, not the value your collateral had when you deposited it. Your position can cross the line while you are asleep.",
  "You are not warned by the protocol before it happens. The Health Factor gauge on your dashboard is the warning — check it, especially in volatile markets.",
  "Liquidation is triggered by the value of your collateral falling (or your debt growing with interest), not by missing a payment. A loan that is not yet due can still be liquidated.",
  "Falling behind on payments is handled separately: an overdue loan gets a grace period before default management steps in.",
];

export const liquidationThresholdRules: string[] = [
  `Everyone starts from a base threshold of ${BASE_LIQUIDATION_THRESHOLD_BPS / 100}% LTV.`,
  "Your trust score raises it — the protocol adds 1.5 basis points of headroom for every reputation point, so a strong borrower can sustain a higher LTV before being liquidated.",
  "Volatile collateral lowers it — half of the asset's volatility (in basis points) is subtracted, because a jumpy asset can fall through the buffer faster.",
  `The result is clamped to between ${MIN_LIQUIDATION_THRESHOLD_BPS / 100}% and ${MAX_LIQUIDATION_THRESHOLD_BPS / 100}% LTV, so no borrower is ever liquidated above or below those bounds.`,
];

/** Worked example used to make the LTV maths concrete on the page. */
export const liquidationExample = {
  collateralLabel: "Collateral deposited",
  collateralValue: "$1,000",
  borrowedLabel: "Amount borrowed",
  borrowedValue: "$700",
  ltvLabel: "Starting LTV",
  ltvValue: "70%",
  thresholdLabel: "Your liquidation threshold",
  thresholdValue: "75%",
  narrative:
    "You are safe at 70% LTV against a 75% threshold. But LTV is debt divided by collateral value — so if your collateral falls to $930 while your debt stays at $700, your LTV rises to ~75% and the keeper can liquidate you. You did not borrow any more; the collateral simply became worth less.",
  takeaway:
    "The smaller the gap between your LTV and your threshold, the smaller the price move needed to liquidate you. Borrowing well below your limit is the cheapest protection there is.",
};

export const avoidLiquidationTips: string[] = [
  "Borrow well under your maximum. Taking the largest loan you are allowed leaves almost no room for a price move.",
  "Watch the Health Factor gauge on your borrower dashboard — it is the single number that tells you how close you are.",
  "Add collateral as soon as you enter the warning band, rather than waiting to see whether the price recovers.",
  "Make partial repayments. Cutting your debt lowers your LTV just as effectively as adding collateral.",
  "Prefer less volatile collateral. A stable asset gets a higher threshold and is far less likely to gap through it.",
];

// ─── FAQ ────────────────────────────────────────────────────────────────────

export const borrowingFaq: FaqEntry[] = [
  {
    category: "Basics",
    question: "What does 'collateralized borrowing' actually mean?",
    answer:
      "You lock up an asset before you borrow. The protocol lets you borrow only a fraction of that asset's value, and holds the asset until you repay. If the value of your collateral falls too far relative to your debt, the protocol sells it to repay the lenders.",
  },
  {
    category: "Basics",
    question: "Do I need collateral if I have a good trust score?",
    answer:
      "Collateralized loans always require collateral. Your trust score does not remove that requirement — it raises the LTV you can safely run at and improves the rate lenders offer you.",
  },
  {
    category: "Basics",
    question: "How long does it take to get funded?",
    answer:
      "It depends on lenders. Your request is listed in the marketplace immediately, and lenders choose which loans to fund based on your trust score, the amount, the APR and the duration. A loan may be funded by several lenders in stages rather than all at once.",
  },
  {
    category: "Collateral & Risk",
    question: "How much can I borrow against my collateral?",
    answer: `By default, up to ${DEFAULT_COLLATERAL_FACTOR_BPS / 100}% of your collateral's value. Individual assets can be configured with a lower or higher collateral factor, so check the figure shown for the specific asset you are depositing.`,
  },
  {
    category: "Collateral & Risk",
    question: "What is a Health Factor and what number should I aim for?",
    answer: `Health Factor is your collateral value divided by your outstanding debt. Below 1.0 your position is under-collateralized and can be liquidated. Keep it above ${HF_SAFE_THRESHOLD} for a comfortable buffer; between ${HF_WARNING_THRESHOLD} and ${HF_SAFE_THRESHOLD} you are in the warning band and should act.`,
  },
  {
    category: "Collateral & Risk",
    question: "Can I be liquidated even if I have never missed a payment?",
    answer:
      "Yes. Liquidation is driven by the value of your collateral against your debt, not by your payment history. If the market price of your collateral falls far enough, your LTV crosses your threshold and the keeper liquidates the position — even on a loan that is not yet due.",
  },
  {
    category: "Collateral & Risk",
    question: "Will I be warned before I am liquidated?",
    answer:
      "The protocol does not send you a warning before liquidating. The Health Factor gauge on your dashboard is the warning signal, and it updates as prices move. Check it regularly, particularly if your collateral is a volatile asset.",
  },
  {
    category: "Collateral & Risk",
    question: "Can I add more collateral to an active loan?",
    answer:
      "Yes, and it is one of the two fastest ways to recover from the warning band. Adding collateral raises your Health Factor and lowers your LTV immediately. Repaying part of the debt has the same effect from the other direction.",
  },
  {
    category: "Collateral & Risk",
    question: "What happens to my collateral if I am liquidated?",
    answer:
      "The keeper marks the loan as Defaulted on-chain. Your collateral stays locked against that debt — you cannot withdraw it, because the contract only releases collateral while your borrowing power covers your active debt — and the position is settled to repay the lenders. A default also damages your trust score, which affects the terms you are offered afterwards.",
  },
  {
    category: "Repayment",
    question: "Can I repay early, or in instalments?",
    answer:
      "Both. Partial repayments are supported at any point during the loan — each one is recorded on-chain and reduces your remaining balance right away. Repaying the full balance early closes the loan and releases your collateral.",
  },
  {
    category: "Repayment",
    question: "What happens if I miss the due date?",
    answer: `Missing the due date is treated separately from liquidation. An overdue loan enters a grace period of ${DEFAULT_GRACE_PERIOD_DAYS} days by default before the default-management process acts on it, so a short delay is recoverable. A loan that goes to default damages your trust score.`,
  },
  {
    category: "Repayment",
    question: "When do I get my collateral back?",
    answer:
      "Once your remaining balance reaches zero the loan status becomes Repaid and that collateral is no longer locked against it. Withdrawing is a separate action you initiate — the contract permits it as long as your remaining borrowing power still covers any other active loans you hold.",
  },
  {
    category: "Costs & Rates",
    question: "Is the rate I see APR or APY?",
    answer:
      "APR. TrustLend loans accrue simple interest, so the rate you are quoted is not compounded. A 12% APR on 100 XLM borrowed for a full year costs 12 XLM in interest.",
  },
  {
    category: "Costs & Rates",
    question: "What is the difference between Fixed and Floating rates?",
    answer:
      "Fixed locks your rate when the loan is created, so your cost is predictable. Floating starts lower and moves with pool utilization — it rises as more of the pool is borrowed. Choose Fixed if you want certainty, Floating if you expect utilization to stay low.",
  },
  {
    category: "Costs & Rates",
    question: "Can I switch between Fixed and Floating after borrowing?",
    answer: `Yes. Switching charges a fee of ${RATE_SWITCH_FEE_BPS / 100}% of your remaining debt and there is a 24-hour cooldown between switches, so it is not something to do reactively on every rate move.`,
  },
];

/** FAQ categories in the order they should be rendered. */
export const faqCategories: FaqEntry["category"][] = [
  "Basics",
  "Collateral & Risk",
  "Repayment",
  "Costs & Rates",
];
