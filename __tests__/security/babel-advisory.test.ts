/**
 * Regression guard for GHSA-968p-4wvh-cqc8 / CVE-2025-27789 (Dependabot #42).
 *
 * The advisory: when Babel compiles a regex with named capturing groups, the
 * `.replace` helper it generates runs in quadratic time for crafted
 * replacement strings. The vulnerable code is in **@babel/helpers** and the
 * runtime packages (@babel/runtime, -corejs2, -corejs3) below 7.26.10, or
 * 8.0.0-alpha.0 to alpha.16 on the 8.x line. @babel/core is checked as well,
 * because the issue's acceptance criteria name it.
 *
 * Nothing pins these today except the "@babel/core" override (which pulls in
 * a patched @babel/helpers) and @solana/web3.js's own range for
 * @babel/runtime, a **production** dependency. Either can move under a
 * lockfile regeneration, so this test fails CI if any resolved copy is
 * vulnerable again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

/** Lowest patched version on each affected release line. */
const PATCHED = ["7.26.10", "8.0.0-alpha.17"];

const PACKAGES = [
  "@babel/helpers",
  "@babel/runtime",
  "@babel/runtime-corejs2",
  "@babel/runtime-corejs3",
  "@babel/core",
];

const root = path.resolve(__dirname, "../..");
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

interface Version {
  core: [number, number, number];
  pre: (string | number)[];
}

function parse(version: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) throw new Error(`not a semver version: ${version}`);
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** SemVer 2.0 precedence: core, then a release outranks any prerelease. */
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Patched if at or above the fix on its own major line, or on a newer major. */
function isPatched(version: string, patched: string[] = PATCHED): boolean {
  const v = parse(version);
  const fixes = patched.map(parse).sort(compare);
  const sameMajor = fixes.find((f) => f.core[0] === v.core[0]);
  if (sameMajor) return compare(v, sameMajor) >= 0;
  return v.core[0] > fixes[fixes.length - 1].core[0];
}

function resolvedCopies(pkg: string): { location: string; version: string }[] {
  return Object.entries(lock.packages as Record<string, { version?: string }>)
    .filter(
      ([location]) => location === `node_modules/${pkg}` || location.endsWith(`/node_modules/${pkg}`),
    )
    .map(([location, entry]) => ({ location, version: entry.version ?? "" }));
}

describe("GHSA-968p-4wvh-cqc8 (Babel named-group .replace helper) stays patched", () => {
  it("reads a lockfile with a `packages` map", () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(lock.packages).toBeTypeOf("object");
  });

  it("finds the packages it guards, so it cannot pass vacuously", () => {
    // @babel/helpers carries the vulnerable helper; @babel/runtime ships it to
    // production. If either disappears, revisit this test rather than let it
    // silently check nothing.
    expect(resolvedCopies("@babel/helpers").length).toBeGreaterThan(0);
    expect(resolvedCopies("@babel/runtime").length).toBeGreaterThan(0);
  });

  it.each(PACKAGES)("every resolved %s is patched", (pkg) => {
    const vulnerable = resolvedCopies(pkg).filter((c) => !isPatched(c.version));
    expect(vulnerable, `vulnerable ${pkg} copies`).toEqual([]);
  });

  describe("isPatched", () => {
    it.each<[string, boolean]>([
      ["7.26.9", false],
      ["7.26.10", true],
      ["7.29.7", true],
      ["8.0.0-alpha.0", false],
      ["8.0.0-alpha.16", false],
      ["8.0.0-alpha.17", true],
      ["8.0.0-beta.1", true],
      ["8.0.0", true],
      ["8.0.7", true],
      ["9.0.0", true],
      ["6.26.0", false],
    ])("%s -> %s", (version, expected) => {
      expect(isPatched(version)).toBe(expected);
    });
  });
});
