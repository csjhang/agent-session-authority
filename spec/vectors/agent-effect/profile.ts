/** Shared rules for asa.agent-effect/0.1 offline verify. */

export const SCHEMA_VERSION = "asa.agent-effect/0.1";

export const OUTCOMES = new Set(["committed", "rejected", "failed", "unknown"]);
export const APPROVAL_DECISIONS = new Set(["grant", "deny", "none"]);
export const RECORD_KINDS = new Set(["effect", "approval"]);

/** Top-level keys excluded from the hashed form (OTEP case C lesson). */
export const INTEGRITY_EXCLUSION = new Set([
  "signature",
  "previous_evidence_hash",
  "integrity",
  "integrity_value",
  "integrity_canonicalization",
  "integrity_signer",
]);

export function isExcludedKey(key: string): boolean {
  if (INTEGRITY_EXCLUSION.has(key)) return true;
  return /^integrity(\.|_)/.test(key);
}

export type RejectCode =
  | "not_object"
  | "unsupported_schema"
  | "missing_required"
  | "bad_type"
  | "bad_outcome"
  | "bad_approval_decision"
  | "bad_record_kind"
  | "numeric_ts_unix_nano"
  | "bad_ts_unix_nano"
  | "integrity_in_hashed_form";

export interface VerifyOk {
  ok: true;
  hashed: Record<string, unknown>;
}

export interface VerifyErr {
  ok: false;
  code: RejectCode;
  message: string;
}

export type VerifyResult = VerifyOk | VerifyErr;

const TS_UNIX_NANO = /^[0-9]+$/;

const MUST_STRING = [
  "schema_version",
  "effect_id",
  "action_digest",
  "boundary_id",
  "stream_id",
  "ts_unix_nano",
] as const;

const MUST_NUMBER = ["runtime_generation", "fence_epoch", "sequence_number"] as const;

export function stripIntegrity(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (isExcludedKey(k)) continue;
    out[k] = v;
  }
  return out;
}

function isNonNegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

export function verifyAgentEffectRecord(
  raw: unknown,
  opts: { hashed_form?: unknown } = {},
): VerifyResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "not_object", message: "record must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;

  if (record.schema_version !== SCHEMA_VERSION) {
    return {
      ok: false,
      code: "unsupported_schema",
      message: `schema_version must be ${SCHEMA_VERSION}`,
    };
  }

  if ("ts_unix_nano" in record && typeof record.ts_unix_nano === "number") {
    return {
      ok: false,
      code: "numeric_ts_unix_nano",
      message: "ts_unix_nano must be a decimal digit string, not a JSON number",
    };
  }

  for (const key of MUST_STRING) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      return { ok: false, code: "missing_required", message: `missing required field ${key}` };
    }
    if (typeof record[key] !== "string") {
      return { ok: false, code: "bad_type", message: `${key} must be a string` };
    }
  }

  for (const key of MUST_NUMBER) {
    if (!(key in record) || record[key] === undefined || record[key] === null) {
      return { ok: false, code: "missing_required", message: `missing required field ${key}` };
    }
    if (!isNonNegativeInteger(record[key])) {
      return {
        ok: false,
        code: "bad_type",
        message: `${key} must be a finite non-negative integer`,
      };
    }
  }

  if (!("outcome" in record) || record.outcome === undefined || record.outcome === null) {
    return { ok: false, code: "missing_required", message: "missing required field outcome" };
  }
  if (typeof record.outcome !== "string" || !OUTCOMES.has(record.outcome)) {
    return {
      ok: false,
      code: "bad_outcome",
      message: 'outcome must be "committed"|"rejected"|"failed"|"unknown"',
    };
  }

  if (!TS_UNIX_NANO.test(record.ts_unix_nano as string)) {
    return {
      ok: false,
      code: "bad_ts_unix_nano",
      message: "ts_unix_nano must match /^[0-9]+$/",
    };
  }

  if ("approval_decision" in record && record.approval_decision !== undefined) {
    if (
      typeof record.approval_decision !== "string" ||
      !APPROVAL_DECISIONS.has(record.approval_decision)
    ) {
      return {
        ok: false,
        code: "bad_approval_decision",
        message: 'approval_decision must be "grant"|"deny"|"none"',
      };
    }
  }

  if ("approval_id" in record && record.approval_id !== undefined && record.approval_id !== null) {
    if (typeof record.approval_id !== "string") {
      return { ok: false, code: "bad_type", message: "approval_id must be a string" };
    }
  }

  if (
    "approval_runtime_generation" in record &&
    record.approval_runtime_generation !== undefined &&
    record.approval_runtime_generation !== null
  ) {
    if (!isNonNegativeInteger(record.approval_runtime_generation)) {
      return {
        ok: false,
        code: "bad_type",
        message: "approval_runtime_generation must be a finite non-negative integer",
      };
    }
  }

  if ("record_kind" in record && record.record_kind !== undefined && record.record_kind !== null) {
    if (typeof record.record_kind !== "string" || !RECORD_KINDS.has(record.record_kind)) {
      return {
        ok: false,
        code: "bad_record_kind",
        message: 'record_kind must be "effect"|"approval" when present',
      };
    }
    if (record.record_kind === "approval") {
      if (record.outcome === "committed") {
        return {
          ok: false,
          code: "bad_record_kind",
          message: 'record_kind="approval" must not have outcome="committed"',
        };
      }
      const hasId =
        typeof record.approval_id === "string" && (record.approval_id as string).length > 0;
      if (!hasId) {
        return {
          ok: false,
          code: "bad_record_kind",
          message: 'record_kind="approval" requires non-empty approval_id',
        };
      }
    }
  }

  if ("hashed_form" in opts && opts.hashed_form !== undefined) {
    if (
      opts.hashed_form === null ||
      typeof opts.hashed_form !== "object" ||
      Array.isArray(opts.hashed_form)
    ) {
      return {
        ok: false,
        code: "integrity_in_hashed_form",
        message: "hashed_form must be an object when provided",
      };
    }
    for (const k of Object.keys(opts.hashed_form as object)) {
      if (isExcludedKey(k)) {
        return {
          ok: false,
          code: "integrity_in_hashed_form",
          message: `hashed_form must not contain integrity key ${k}`,
        };
      }
    }
  }

  const hashed = stripIntegrity(record);
  return { ok: true, hashed };
}
