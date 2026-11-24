import type { UserConfig } from "@commitlint/types";

/**
 * commitlint configuration for TrustLend.
 *
 * Extends `@commitlint/config-conventional` with additional scopes and types
 * relevant to the project's stack (Soroban, Stellar, Next.js, Neon).
 *
 * Conventional commit format:
 *   <type>(<scope>): <subject>
 *   <BLANK LINE>
 *   <body>
 *   <BLANK LINE>
 *   <footer>
 */
const Configuration: UserConfig = {
  extends: ["@commitlint/config-conventional"],

  // Additional types beyond the conventional ones (feat, fix, docs, style,
  // refactor, perf, test, build, ci, chore, revert)
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
        // Soroban-specific: smart-contract logic changes
        "contract",
        // Blockchain/Stellar related changes (not smart-contracts)
        "stellar",
        // Security-related changes
        "security",
      ],
    ],

    // Allow scopes relevant to the monorepo structure
    "scope-enum": [
      2,
      "always",
      [
        "lending",
        "escrow",
        "governance",
        "default-management",
        "multisig-admin",
        "borrower-reputation",
        "auto-compound-vault",
        "treasury",
        "contracts",
        "frontend",
        "dashboard",
        "auth",
        "kyc",
        "api",
        "ci",
        "db",
        "neon",
        "drizzle",
        "stellar",
        "soroban",
        "docs",
        "deps",
        "config",
        "landing",
        "hooks",
        "referrals",
      ],
    ],

    // Subject must not be empty
    "subject-empty": [2, "never"],

    // Subject must not end with a period
    "subject-full-stop": [2, "never", "."],

    // Existing commits use both lower-case and capitalized imperative
    // subjects, so do not reject either convention.
    "subject-case": [0],

    // Header max length
    "header-max-length": [2, "always", 100],
  },

  // Allow both lowercase and uppercase types at the prompt level
  // (conventional commits are case-insensitive for the type)
  prompt: {
    settings: {
      enableMultipleScopes: true,
      scopeEnumSeparator: ",",
    },
  },
};

export default Configuration;
