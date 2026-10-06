import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate_json } from "./schema.js";

export type Auth08DisclosureKind = "bypass" | "coverage_boundary" | "e2e_claim" | "anti_e2e";
export type Auth08VerificationStatus = "unverified" | "found" | "not_found";

export interface Auth08DisclosureEntry {
  bypass_path_id: string;
  quote: string;
  url: string;
  retrieved: string;
  section: string;
  doc_product_version: string;
  version_relationship: string;
  kind: Auth08DisclosureKind;
  verification: {
    status: Auth08VerificationStatus;
    verified_at?: string;
    notes?: string;
  };
}

export interface Auth08Disclosures {
  target: string;
  pinned_version: string;
  entries: Auth08DisclosureEntry[];
}

export interface LoadAuth08DisclosuresExpect {
  target: string;
  pinned_version?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DISCLOSURES_SCHEMA_PATH = path.resolve(
  here,
  "../../../spec/auth08-disclosures.schema.json",
);

let _disclosures_schema: unknown | undefined;
function disclosures_schema(): unknown {
  if (_disclosures_schema === undefined) {
    _disclosures_schema = JSON.parse(fs.readFileSync(DISCLOSURES_SCHEMA_PATH, "utf8"));
  }
  return _disclosures_schema;
}

/** Count English words: trim ends, split on /\s+/. Empty after trim → 0. */
export function count_english_words(s: string): number {
  const trimmed = s.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

const NON_EMPTY_ENTRY_FIELDS = [
  "bypass_path_id",
  "url",
  "section",
  "retrieved",
  "doc_product_version",
  "version_relationship",
] as const;

/**
 * Load and validate AUTH-08 disclosure records.
 * Throws on parse/schema/semantic/target mismatch (CLI maps to exit 2).
 * Does not network; does not mutate verification.status.
 */
export function load_auth08_disclosures(
  file_path: string,
  expect: LoadAuth08DisclosuresExpect,
): Auth08Disclosures {
  if (!fs.existsSync(file_path)) {
    throw new Error(`disclosures file not found: ${file_path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file_path, "utf8"));
  } catch (err) {
    throw new Error(`disclosures JSON parse failed for ${file_path}: ${String(err)}`);
  }
  const errors = validate_json(disclosures_schema(), raw);
  if (errors.length > 0) {
    throw new Error(
      `disclosures schema validation failed for ${file_path}:\n${errors.join("\n")}`,
    );
  }
  const file = raw as Auth08Disclosures;

  if (file.target !== expect.target) {
    throw new Error(
      `disclosures target mismatch: file=${file.target} expect=${expect.target}`,
    );
  }
  if (
    expect.pinned_version !== undefined &&
    file.pinned_version !== expect.pinned_version
  ) {
    throw new Error(
      `disclosures pinned_version mismatch: file=${file.pinned_version} expect=${expect.pinned_version}`,
    );
  }

  for (let i = 0; i < file.entries.length; i++) {
    const entry = file.entries[i]!;
    const quote = entry.quote;
    if (typeof quote !== "string" || quote.trim().length === 0) {
      throw new Error(`quote empty at entries[${i}]`);
    }
    const n = count_english_words(quote);
    if (n > 25) {
      throw new Error(`quote exceeds 25 English words at entries[${i}] (got ${n})`);
    }
    for (const field of NON_EMPTY_ENTRY_FIELDS) {
      const v = entry[field];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error(`${field} empty at entries[${i}]`);
      }
    }
  }

  return file;
}
