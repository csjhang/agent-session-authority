import { describe, expect, it } from "vitest";
import { canonicalize } from "./jcs.js";
import {
  loadCrossVectors,
  loadVectors,
  runCrossVector,
  runVector,
  sha256Hex,
} from "./verify.js";
import { stripIntegrity } from "./profile.js";
import { verifyCrossRecords } from "./cross-verify.js";

describe("agent-effect JCS vectors", () => {
  const vectors = loadVectors();

  it("loads pass and reject fixtures", () => {
    expect(vectors.some((v) => v.expect === "pass")).toBe(true);
    expect(vectors.some((v) => v.expect === "reject")).toBe(true);
    expect(vectors.map((v) => v.id).sort()).toEqual([
      "pass-01-minimal",
      "pass-02-with-approval-unknown-outcome",
      "reject-01-numeric-ts-unix-nano",
      "reject-02-missing-action-digest",
      "reject-03-integrity-in-hashed-form",
      "reject-04-approval-runtime-generation-string",
      "reject-05-approval-runtime-generation-negative",
      "reject-06-runtime-generation-non-integer",
      "reject-07-approval-id-number",
      "reject-08-record-kind-wrong-case",
      "reject-09-approval-missing-approval-id",
      "reject-10-approval-outcome-committed",
      "reject-11-approval-id-empty-string",
      "reject-12-approval-id-null",
      "reject-13-approval-runtime-generation-null",
      "reject-14-record-kind-null",
      "reject-15-approval-record-decision-none",
      "reject-16-sequence-number-unsafe-integer",
    ]);
  });

  for (const v of vectors) {
    it(`${v.expect}: ${v.id}`, () => {
      const r = runVector(v);
      expect(r.ok, r.detail).toBe(true);
    });
  }

  it("signature does not change hashed JCS", () => {
    const pass = vectors.find((v) => v.id === "pass-01-minimal")!;
    const rec = pass.record as Record<string, unknown>;
    const a = canonicalize(stripIntegrity(rec));
    const b = canonicalize(stripIntegrity({ ...rec, signature: "OTHER" }));
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(pass.expected_jcs_sha256);
  });
});

describe("agent-effect cross-record authority", () => {
  const cross = loadCrossVectors();

  it("loads pass, reject, and report fixtures covering rules 1–7", () => {
    expect(cross.some((v) => v.expect === "pass")).toBe(true);
    expect(cross.some((v) => v.expect === "reject")).toBe(true);
    expect(cross.some((v) => v.expect === "report")).toBe(true);
    const covered = new Set(cross.flatMap((v) => v.rules ?? []));
    expect([...covered].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  for (const v of cross) {
    it(`${v.expect}: ${v.id}`, () => {
      const r = runCrossVector(v);
      expect(r.ok, r.detail).toBe(true);
    });
  }

  it("gaps alone do not set ok=false", () => {
    const gap = cross.find((v) => v.id === "cross-report-07-sequence-gap")!;
    const result = verifyCrossRecords(gap.records);
    expect(result.ok).toBe(true);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("unknown without approval is not unauthorized_effect", () => {
    const v = cross.find((v) => v.id === "cross-pass-06-unknown-not-committed")!;
    const result = verifyCrossRecords(v.records);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.unknowns.map((u) => u.effect_id)).toEqual(["eff-u"]);
  });
});


describe("agent-effect cross-record permutation invariance", () => {
  const cross = loadCrossVectors();

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr.slice()];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) out.push([arr[i]!, ...p]);
    }
    return out;
  }

  function shuffle<T>(arr: T[], rng: () => number): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  function summary(records: unknown[], options?: { requireIssuance?: boolean }) {
    const r = verifyCrossRecords(records, options);
    return {
      ok: r.ok,
      violations: [...new Set(r.violations.map((v) => v.code))].sort(),
      reports: [...new Set(r.reports.map((x) => x.code))].sort(),
      gaps: [...new Set(r.gaps.map((g) => g.stream_id))].sort(),
      unknowns: [...new Set(r.unknowns.map((u) => u.effect_id))].sort(),
    };
  }

  for (const v of cross) {
    it(`permutation-invariant: ${v.id}`, () => {
      const options = (v as { options?: { requireIssuance?: boolean } }).options;
      const baseline = summary(v.records, options);
      const n = v.records.length;
      const variants: unknown[][] =
        n <= 6
          ? permutations(v.records)
          : Array.from({ length: 200 }, (_, i) => shuffle(v.records, mulberry32(0xae00 + i)));
      for (const recs of variants) {
        const originalIndices = recs.map((r) => v.records.indexOf(r));
        expect(
          summary(recs, options),
          `order=${JSON.stringify(originalIndices)}`,
        ).toEqual(baseline);
      }
    });
  }
});

describe("jcs basics", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/JCS/);
  });
});
