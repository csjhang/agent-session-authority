import { describe, expect, it } from "vitest";
import { canonicalize } from "./jcs.js";
import { loadVectors, runVector, sha256Hex } from "./verify.js";
import { stripIntegrity } from "./profile.js";

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

describe("jcs basics", () => {
  it("sorts object keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/JCS/);
  });
});
