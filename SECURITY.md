# Security Policy & Coordinated Vulnerability Disclosure

TrustLend is an open-source decentralized lending protocol built on Stellar and Soroban. We welcome security researchers, developers, and community members to inspect our smart contracts, API endpoints, and infrastructure to help identify potential vulnerabilities.

> **Program Notice:** TrustLend is an open-source educational and community project. We do **not** operate a paid bug bounty program and do **not** offer financial rewards, bounties, or monetary compensation for vulnerability submissions. We provide safe harbor, public acknowledgment, and contributor attribution in repository release notes and security advisories for confirmed responsible disclosures.

---

## 1. Reporting a Vulnerability

If you discover a security vulnerability within TrustLend, **do NOT open a public GitHub issue** or publicly disclose the issue until it has been acknowledged, investigated, and remediated by the maintainers.

### Secure Disclosure Instructions
1. **Email:** Send your report securely to `souvikmandals10@gmail.com` (Maintainer Email) or submit via GitHub Private Vulnerability Reporting.
2. **Details Required:**
   - **Summary:** Concise explanation of the vulnerability and its potential impact.
   - **Component:** The specific smart contract, API endpoint, script, or component affected.
   - **Reproduction Steps:** Step-by-step instructions or executable Proof-of-Concept (PoC) code/test case.
   - **Suggested Mitigation:** Optional recommendations for remediation.
3. **Response SLA:**
   - **Initial Response:** Within 48 hours acknowledging receipt of report.
   - **Triage & Evaluation:** Status update within 5 business days.
   - **Remediation & Attribution:** Resolution timeline, advisory publication, and public contributor credit in release notes upon patch confirmation.

---

## 2. Security Disclosure Scope

### In-Scope Assets

#### A. Smart Contracts (`contracts/`)
- **Lending Pool Contract (`contracts/lending`)**: Core liquidity pool operations, deposits, borrowing, repayments, interest rate models, and flash loans.
- **Escrow / Collateral Contract (`contracts/escrow`)**: Lockup, withdrawal, collateral ratio management, and custody logic.
- **Borrower Reputation Contract (`contracts/borrower_reputation`)**: Credit score verification, reputation tiers, and rate assignment.
- **Default Management Contract (`contracts/default_management`)**: Liquidation triggers, grace period handling, keeper execution, and auction mechanisms.
- **Governance Contract (`contracts/governance`)**: Voting logic, proposal execution, timelocks, and token voting rules.
- **Multisig Admin Contract (`contracts/multisig_admin`)**: M-of-N threshold signature validation, admin actions, and key management.

#### B. Backend Services & APIs (`app/api/` & `proxy.ts`)
- **Authentication & Authorization (`app/api/auth/*`, `proxy.ts`)**: Sign-In with Stellar (SIWS) authentication, session handling, and JWT validation.
- **Core Loan & Pool APIs (`app/api/loans/*`, `app/api/pools/*`)**: Loan request creation, repayment processing, pool analytics.
- **Gas & Sponsor Service (`app/api/sponsor/*`)**: Fee sponsorship, relayer protection, rate limits, and abuse prevention.
- **Reputation & Oracle System (`app/api/reputation/*`, `scripts/oracle-post-credit-score.mjs`)**: Credit score calculation, oracle posting logic, and data validation.
- **Automation Keepers & Cron (`app/api/cron/*`, `app/api/tasks/*`, `scripts/liquidation-keeper.ts`)**: Automated liquidations and background task runners.

### Out-of-Scope Assets & Issues
- **Frontend/UI Bugs:** Visual presentation flaws, CSS issues, or non-security UI bugs without impact on user funds or data.
- **Denial of Service (DoS):** Volumetric DoS/DDoS attacks against infrastructure or public Stellar RPC endpoints not caused by application design flaws.
- **Social Engineering:** Phishing, spam, or social engineering attacks targeted at TrustLend maintainers or users.
- **Third-Party Dependencies:** Vulnerabilities in underlying infrastructure (e.g. Stellar Core, Soroban SDK, Neon, Vercel) unless directly exploitable through TrustLend code logic.
- **Known Issues:** Vulnerabilities already reported, tracked in public issues/PRs, or previously disclosed in security audit reports.

---

## 3. Vulnerability Severity Classification

Vulnerabilities are evaluated based on standard CVSS v3.1 frameworks and threat modeling specific to DeFi protocols to prioritize remediation:

| Severity Level | Description & Protocol Impact | Priority |
| :--- | :--- | :--- |
| **Critical** | Direct theft/loss of user funds or escrowed collateral, unauthorized draining of liquidity pool assets, flash loan exploits causing uncollateralized fund extraction, or full admin key / governance takeover. | **P0 (Critical)** |
| **High** | Permanent lockup/freeze of collateral without recovery mechanism, manipulation of oracle credit scores/price feeds leading to unauthorized borrowing/liquidation, or unauthorized manipulation of borrower reputation scores. | **P1 (High)** |
| **Medium** | Partial fee/interest loss, rate limiting / fee-sponsorship bypass draining sponsor reserve balance, or high-impact API authentication / session bypass without direct access to vault collateral. | **P2 (Medium)** |
| **Low** | Minor API information disclosure, telemetry data leakage, non-critical state inconsistencies, or isolated contract panic / DoS conditions on non-essential functions. | **P3 (Low)** |

---

## 4. Rules of Engagement & Safe Harbor

### Researcher Guidelines
- Make good-faith efforts to avoid privacy violations, destruction of data, and interruption or degradation of services.
- Do not exploit a vulnerability beyond what is necessary to prove the existence of the vulnerability (use testnet/mock environments for PoC).
- Do not access user data or private keys that do not belong to you.

### Safe Harbor Protection
TrustLend considers security research conducted in accordance with this policy to be:
- Authorized under applicable anti-hacking laws, and we will not initiate legal action against researchers for good-faith security research.
- Exempt from restrictions in our Terms of Service that prohibit reverse engineering or probing.
- Supported and valued as an essential contribution to protocol security.

---

## 5. Supported Versions

| Version | Supported |
| :--- | :--- |
| `0.1.x` | :white_check_mark: |
