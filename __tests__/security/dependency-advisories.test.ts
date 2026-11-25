/**
 * Regression guard for dependency advisories fixed by an npm `overrides` pin.
 *
 * An override only protects us while it stays in package.json *and* the
 * lockfile actually resolves to a patched version. Either can regress
 * silently: removing the override, or regenerating the lockfile, can put a
 * vulnerable copy back without any test noticing, because CI installs from the
 * lockfile and never checks what it resolved. These assertions fail CI first.
 *
 * To guard another advisory, add a row to ADVISORIES.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

interface Advisory {
  pkg: string;
  id: string;
  /** Lowest patched version on each still-supported major line. */
  patched: string[];
}

const ADVISORIES: Advisory[] = [
  {
    // mailto: header injection (Dependabot alert #117). Reaches us only via
    // @commitlint/config-validator -> ajv@8 (dev tooling), pinned to the
    // patched 4.x line by the "fast-uri" override in package.json.
    pkg: "fast-uri",
    id: "GHSA-83f7-4hh3-vchq",
    patched: ["3.0.6", "4.1.1"],
  },
];

const root = path.resolve(__dirname, "../..");
const pkgJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));

type Version = [number, number, number];

function parse(version: string): Version {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) throw new Error(`not a semver version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Patched if at or above the fix on its own major line, or on a newer major. */
function isPatched(version: string, patched: string[]): boolean {
  const v = parse(version);
  const fixes = patched.map(parse).sort(compare);
  const sameMajor = fixes.find((f) => f[0] === v[0]);
  if (sameMajor) return compare(v, sameMajor) >= 0;
  // A major newer than every patched line inherits the fix; an older one,
  // or one between lines with no backport, does not.
  return v[0] > fixes[fixes.length - 1][0];
}

/** Every copy of `pkg` the lockfile resolves, with its install path. */
function resolvedCopies(pkg: string): { location: string; version: string }[] {
  return Object.entries(lock.packages as Record<string, { version?: string }>)
    .filter(([location]) => location === `node_modules/${pkg}` || location.endsWith(`/node_modules/${pkg}`))
    .map(([location, entry]) => ({ location, version: entry.version ?? "" }));
}

describe("dependency advisories stay patched", () => {
  it("uses a v3 lockfile, whose `packages` map these checks read", () => {
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);
    expect(lock.packages).toBeTypeOf("object");
  });

  describe.each(ADVISORIES)("$pkg ($id)", ({ pkg, patched }) => {
    it("is pinned by an override with a patched floor", () => {
      const override: unknown = pkgJson.overrides?.[pkg];
      expect(typeof override, `package.json overrides.${pkg} is missing`).toBe("string");
      const floor = /^>=\s*(\d+\.\d+\.\d+)/.exec(override as string);
      expect(floor, `overrides.${pkg} should be a ">=" range, got "${override}"`).not.toBeNull();
      expect(isPatched(floor![1], patched)).toBe(true);
    });

    it("resolves every copy in package-lock.json to a patched version", () => {
      const copies = resolvedCopies(pkg);
      expect(copies.length, `${pkg} is no longer in the lockfile; drop this row`).toBeGreaterThan(0);
      const vulnerable = copies.filter((c) => !isPatched(c.version, patched));
      expect(vulnerable, `vulnerable ${pkg} copies`).toEqual([]);
    });
  });

  describe("isPatched", () => {
    const fixes = ["3.0.6", "4.1.1"];
    it.each<[string, boolean]>([
      ["3.0.5", false],
      ["3.0.6", true],
      ["3.1.0", true],
      ["4.0.0", false],
      ["4.1.0", false],
      ["4.1.1", true],
      ["4.2.2", true],
      ["5.0.0", true],
      ["2.9.9", false],
    ])("%s -> %s", (version, expected) => {
      expect(isPatched(version, fixes)).toBe(expected);
    });
  });
});
