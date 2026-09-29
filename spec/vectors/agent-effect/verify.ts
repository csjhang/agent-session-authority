/**
 * Offline verifier for asa.agent-effect/0.1 JCS vectors + cross-record authority.
 *
 * Usage:
 *   pnpm exec tsx spec/vectors/agent-effect/verify.ts
 *   pnpm exec vitest run --config spec/vectors/agent-effect/vitest.config.ts
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalize } from "./jcs.js";
import {
  stripIntegrity,
  verifyAgentEffectRecord,
  type RejectCode,
} from "./profile.js";
import { verifyCrossRecords, type CrossViolationCode } from "./cross-verify.js";

export interface VectorFile {
  id: string;
  expect: "pass" | "reject";
  description: string;
  reject_code?: RejectCode;
  record: unknown;
  /** When set, verifier checks this object must not contain exclusion keys. */
  hashed_form?: unknown;
  /** Exact JCS string of stripIntegrity(record); required for pass vectors. */
  expected_jcs?: string;
  /** SHA-256 hex of UTF-8 expected_jcs; optional cross-check. */
  expected_jcs_sha256?: string;
}

export interface CrossVectorExpected {
  ok: boolean;
  violation_codes: CrossViolationCode[];
  gap_streams: string[];
  unknown_effect_ids: string[];
  gap_missing?: number[];
}

export interface CrossVectorFile {
  id: string;
  expect: "pass" | "reject" | "report";
  kind: "cross_record";
  description: string;
  rules?: number[];
  records: unknown[];
  expected: CrossVectorExpected;
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function runVector(v: VectorFile): { ok: boolean; detail: string } {
  const base = verifyAgentEffectRecord(v.record, { hashed_form: v.hashed_form });
  const result = !base.ok
    ? base
    : { ok: true as const, hashed: base.hashed, jcs: canonicalize(base.hashed) };

  if (v.expect === "reject") {
    if (result.ok) {
      return { ok: false, detail: `${v.id}: expected reject, but passed` };
    }
    if (v.reject_code && result.code !== v.reject_code) {
      return {
        ok: false,
        detail: `${v.id}: expected reject_code=${v.reject_code}, got ${result.code} (${result.message})`,
      };
    }
    return { ok: true, detail: `${v.id}: reject ${result.code}` };
  }

  if (!result.ok) {
    return { ok: false, detail: `${v.id}: expected pass, got ${result.code}: ${result.message}` };
  }
  if (!v.expected_jcs) {
    return { ok: false, detail: `${v.id}: pass vector missing expected_jcs` };
  }
  if (result.jcs !== v.expected_jcs) {
    return {
      ok: false,
      detail: `${v.id}: JCS mismatch\n  got:  ${result.jcs}\n  want: ${v.expected_jcs}`,
    };
  }
  const digest = sha256Hex(result.jcs);
  if (v.expected_jcs_sha256 && digest !== v.expected_jcs_sha256) {
    return {
      ok: false,
      detail: `${v.id}: sha256 mismatch got=${digest} want=${v.expected_jcs_sha256}`,
    };
  }
  if (v.record && typeof v.record === "object" && !Array.isArray(v.record)) {
    const stripped = stripIntegrity(v.record as Record<string, unknown>);
    if (canonicalize(stripped) !== result.jcs) {
      return { ok: false, detail: `${v.id}: stripIntegrity JCS drifted` };
    }
  }
  return { ok: true, detail: `${v.id}: pass sha256=${digest.slice(0, 12)}…` };
}

function sortedUnique<T extends string | number>(xs: T[]): T[] {
  return [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function runCrossVector(v: CrossVectorFile): { ok: boolean; detail: string } {
  const result = verifyCrossRecords(v.records);
  const gotCodes = sortedUnique(result.violations.map((x) => x.code));
  const wantCodes = sortedUnique(v.expected.violation_codes);
  const gotGaps = sortedUnique(result.gaps.map((g) => g.stream_id));
  const wantGaps = sortedUnique(v.expected.gap_streams);
  const gotUnknowns = sortedUnique(result.unknowns.map((u) => u.effect_id));
  const wantUnknowns = sortedUnique(v.expected.unknown_effect_ids);

  const mismatches: string[] = [];
  if (result.ok !== v.expected.ok) {
    mismatches.push(`ok got=${result.ok} want=${v.expected.ok}`);
  }
  if (JSON.stringify(gotCodes) !== JSON.stringify(wantCodes)) {
    mismatches.push(`violation_codes got=${gotCodes.join(",") || "∅"} want=${wantCodes.join(",") || "∅"}`);
  }
  if (JSON.stringify(gotGaps) !== JSON.stringify(wantGaps)) {
    mismatches.push(`gap_streams got=${gotGaps.join(",") || "∅"} want=${wantGaps.join(",") || "∅"}`);
  }
  if (JSON.stringify(gotUnknowns) !== JSON.stringify(wantUnknowns)) {
    mismatches.push(
      `unknown_effect_ids got=${gotUnknowns.join(",") || "∅"} want=${wantUnknowns.join(",") || "∅"}`,
    );
  }
  if (v.expected.gap_missing) {
    const allMissing = sortedUnique(result.gaps.flatMap((g) => g.missing));
    const wantMissing = sortedUnique(v.expected.gap_missing);
    if (JSON.stringify(allMissing) !== JSON.stringify(wantMissing)) {
      mismatches.push(
        `gap_missing got=${allMissing.join(",") || "∅"} want=${wantMissing.join(",") || "∅"}`,
      );
    }
  }

  if (mismatches.length > 0) {
    const violMsg = result.violations.map((x) => `${x.code}:${x.message}`).join("; ");
    return {
      ok: false,
      detail: `${v.id}: ${mismatches.join(" | ")}${violMsg ? ` | detail=${violMsg}` : ""}`,
    };
  }

  const tag =
    v.expect === "reject"
      ? `reject [${gotCodes.join(",")}]`
      : v.expect === "report"
        ? `report gaps=${gotGaps.join(",") || "∅"} unknowns=${gotUnknowns.join(",") || "∅"}`
        : "pass";
  return { ok: true, detail: `${v.id}: ${tag}` };
}

export function loadVectors(dir: string = dirname(fileURLToPath(import.meta.url))): VectorFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && (f.startsWith("pass-") || f.startsWith("reject-")))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as VectorFile);
}

export function loadCrossVectors(
  dir: string = dirname(fileURLToPath(import.meta.url)),
): CrossVectorFile[] {
  return readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".json") &&
        (f.startsWith("cross-pass-") ||
          f.startsWith("cross-reject-") ||
          f.startsWith("cross-report-")),
    )
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as CrossVectorFile);
}

export function main(): number {
  const vectors = loadVectors();
  const cross = loadCrossVectors();
  let failed = 0;
  for (const v of vectors) {
    const r = runVector(v);
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log("--- cross-record ---");
  for (const v of cross) {
    const r = runCrossVector(v);
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  const total = vectors.length + cross.length;
  console.log(`\n${total - failed}/${total} vectors ok`);
  return failed === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main());
}
