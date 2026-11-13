import type {
  AboutContent,
  FaqItem,
  FooterLink,
  HowItWorksStep,
  TrustBadge,
  HighlightContent,
  HeroContent,
  MetricItem,
  NavItem,
  P2PStep,
  ReasonItem,
  StepItem,
} from "@/types/landing";

/** Canonical repository, used for every security/source link below. */
const REPO_URL = "https://github.com/thisisouvik/trustlend-stellar";

export const navItems: NavItem[] = [
  { label: "Home", href: "#home" },
  { label: "Introduce", href: "#introduce" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Journey", href: "#journey" },
  { label: "P2P", href: "#p2p" },
  { label: "Security", href: "#security" },
  { label: "FAQ", href: "#faq" },
];

export const heroContent: HeroContent = {
  eyebrow: "Reputation-based micro-lending on Stellar",
  titleMain: "Credit built on behavior,",
  titleAccent: "not collateral.",
  description:
    "TrustLend connects borrowers and lenders through an on-chain trust score. Sign in with your Stellar wallet, build reputation with every repayment, and unlock fair capital without paperwork.",
};

export const metrics: MetricItem[] = [
  { value: "$110B+", label: "Potential lending volume" },
  { value: "15M+", label: "Emerging market freelancers" },
  { value: "98.5%", label: "Target repayment success" },
  { value: "<2 Min", label: "Wallet sign-in, no passwords" },
];

export const highlightContent: HighlightContent = {
  title: "Anytime, Anywhere",
  description:
    "TrustLend helps users build reputation from real behavior and unlock fair capital without paperwork-heavy approval cycles.",
  callout:
    "No paid tasks. No synthetic score farming. Just real financial trust that compounds with every healthy action.",
};

export const processSteps: StepItem[] = [
  {
    step: "01",
    title: "Choose a role + sign in",
    description:
      "Pick Borrower or Lender and sign in by signing a challenge with your Stellar wallet.",
  },
  {
    step: "02",
    title: "Connect your trust profile",
    description:
      "Your profile starts with a baseline trust score and tracks all meaningful activity.",
  },
  {
    step: "03",
    title: "Build reputation from behavior",
    description:
      "Score grows through repayment consistency, lending participation, and transaction discipline.",
  },
  {
    step: "04",
    title: "Access fair micro-loans",
    description:
      "Borrowers unlock faster approvals while lenders allocate to transparent diversified pools.",
  },
  {
    step: "05",
    title: "Scale with compounding trust",
    description:
      "Each healthy cycle expands credit access, confidence, and long-term economic mobility.",
  },
];

export const reasons: ReasonItem[] = [
  { title: "User-friendly credit access" },
  { title: "24/7 transparent score updates" },
  { title: "No collateral-first bias" },
  { title: "Fast global transaction rails" },
  { title: "Behavior-based risk controls" },
];

export const aboutContent: AboutContent = {
  title: "Conduct P2P transactions in just 3 steps",
  description:
    "A clear flow gives both sides confidence: borrowers request with trust context, lenders confirm with transparent signals, and payouts settle quickly.",
};

export const p2pSteps: P2PStep[] = [
  {
    step: "1",
    title: "Place request with trust profile",
    description:
      "Borrowers submit amount and purpose, and lenders instantly view behavior-based reputation data.",
  },
  {
    step: "2",
    title: "Confirm terms and repayment plan",
    description:
      "Both sides lock terms clearly with expected duration and transparent repayment checkpoints.",
  },
  {
    step: "3",
    title: "Unlock capital and track lifecycle",
    description:
      "Funds are released and every repayment milestone updates trust signals for future access.",
  },
];

export const faqItems: FaqItem[] = [
  {
    question: "What is TrustLend?",
    answer:
      "TrustLend is a reputation-based micro-lending platform where creditworthiness is driven by real financial behavior, not collateral or paid tasks.",
  },
  {
    question: "Do I need to create an account with email and password?",
    answer:
      "No. TrustLend uses Sign-In with Stellar (SEP-10): you prove ownership of a wallet by signing a challenge, and that wallet is your account. Varial, xBull, Albedo and WalletConnect mobile wallets are supported.",
  },
  {
    question: "How is reputation calculated?",
    answer:
      "The score primarily reflects repayment history, lending activity, transaction consistency, and verified external financial signals.",
  },
  {
    question: "How does TrustLend differ from typical DAO lending platforms?",
    answer:
      "Most DAO platforms rely on collateral-heavy crypto-native flows. TrustLend is built for real-world freelancers and unbanked users using behavior-based trust.",
  },
  {
    question: "Can lenders monitor risk transparently?",
    answer:
      "Yes. Lenders can inspect borrower trust signals, repayment progression, and pool-level outcomes with transparent data visibility.",
  },
];

export const footerLinks: FooterLink[] = [
  { label: "Introduce", href: "#introduce" },
  { label: "Journey", href: "#journey" },
  { label: "P2P", href: "#p2p" },
  { label: "FAQ", href: "#faq" },
  { label: "Security", href: "#security" },
  { label: "Borrowing Guide", href: "/docs/borrowing" },
];

export const howItWorksSteps: HowItWorksStep[] = [
  {
    id: "connect",
    caption: "Connect",
    title: "Sign in with your Stellar wallet",
    description:
      "Authenticate by signing a SEP-10 challenge with Varial, xBull, Albedo, or any mobile wallet over WalletConnect. No password, and TrustLend never holds your keys.",
    visual: "wallet",
  },
  {
    id: "reputation",
    caption: "Build trust",
    title: "Earn an on-chain reputation score",
    description:
      "Repayment history, lending activity, and account age are scored by the borrower_reputation contract. The inputs and the maths are public, so your score is auditable rather than opaque.",
    visual: "reputation",
  },
  {
    id: "funding",
    caption: "Get funded",
    title: "Borrow from a transparent pool",
    description:
      "Your score sets your limit and rate. Lender capital is released by the escrow contract, so funds move under contract rules instead of trusting a counterparty.",
    visual: "funding",
  },
  {
    id: "repayment",
    caption: "Grow",
    title: "Repay and unlock more credit",
    description:
      "Each on-time repayment settles the escrow and raises your score, which widens your limit and lowers your rate on the next loan.",
    visual: "repayment",
  },
];

/**
 * Trust signals shown on the landing page.
 *
 * Each entry links to something a visitor can open and verify themselves. Do
 * not add a badge for a third-party audit or certification the project has not
 * actually undergone — an unverifiable claim here is worse than no badge.
 */
export const trustBadges: TrustBadge[] = [
  {
    label: "Security policy & disclosure",
    detail: "Coordinated disclosure process with a 48-hour response SLA.",
    href: `${REPO_URL}/blob/main/SECURITY.md`,
    icon: "shield",
    external: true,
  },
  {
    label: "Formally verified contracts",
    detail: "Core accounting invariants proved with Kani and property tests in CI.",
    href: `${REPO_URL}/blob/main/docs/formal-verification.md`,
    icon: "verified",
    external: true,
  },
  {
    label: "Automated security audits",
    detail: "Every commit runs cargo-audit and Clippy against the Soroban contracts.",
    href: `${REPO_URL}/blob/main/.github/workflows/contract-security.yml`,
    icon: "openSource",
    external: true,
  },
  {
    label: "Non-custodial on Stellar",
    detail: "Open-source Soroban contracts you can read and verify on-chain.",
    href: `${REPO_URL}/tree/main/contracts`,
    icon: "chain",
    external: true,
  },
];
