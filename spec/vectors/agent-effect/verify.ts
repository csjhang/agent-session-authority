/**
 * Offline verifier for asa.agent-effect/0.1 JCS vectors.
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

export function loadVectors(dir: string = dirname(fileURLToPath(import.meta.url))): VectorFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && (f.startsWith("pass-") || f.startsWith("reject-")))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as VectorFile);
}

export function main(): number {
  const vectors = loadVectors();
  let failed = 0;
  for (const v of vectors) {
    const r = runVector(v);
    console.log(`${r.ok ? "OK  " : "FAIL"} ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\n${vectors.length - failed}/${vectors.length} vectors ok`);
  return failed === 0 ? 0 : 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exit(main());
}
