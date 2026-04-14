import type {
  AboutContent,
  FaqItem,
  FooterLink,
  HighlightContent,
  HeroContent,
  MetricItem,
  NavItem,
  P2PStep,
  ReasonItem,
  StepItem,
} from "@/types/landing";

export const navItems: NavItem[] = [
  { label: "Home", href: "#home" },
  { label: "Introduce", href: "#introduce" },
  { label: "Journey", href: "#journey" },
  { label: "P2P", href: "#p2p" },
  { label: "FAQ", href: "#faq" },
];

export const heroContent: HeroContent = {
  eyebrow: "One network for two users",
  titleMain: "Borrow smarter.",
  titleAccent: "Lend with confidence.",
  description:
    "TrustLend connects borrowers and lenders through behavior-based reputation and clear role-specific workflows.",
};

export const metrics: MetricItem[] = [
  { value: "$110B+", label: "Potential lending volume" },
  { value: "15M+", label: "Emerging market freelancers" },
  { value: "98.5%", label: "Target repayment success" },
  { value: "<2 Min", label: "Google or email onboarding" },
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
    title: "Choose role + sign in",
    description:
      "Pick Borrower or Lender and enter with Google or email login in one flow.",
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
      "You can use either Google sign-in or classic email and password. Both support borrower and lender role selection.",
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
];
