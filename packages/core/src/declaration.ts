import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate_json } from "./schema.js";

export type GenerationModel = "G0" | "G1" | "G2";

export type ClaimStatus = "declared" | "not_declared" | "out_of_scope" | "underspecified";

export interface AuthorityProfile {
  profile_version?: string;
  target?: string;
  generation_model?: GenerationModel;
  claimed_invariants?: string[];
  scope_decision?: Record<string, string>;
  scope_map?: Array<{ action_type: string; target: string; scope_id: string }>;
  known_bypasses?: string[];
  coverage_boundary?: string;
  terminal_rules?: Record<string, string>;
  notes?: string;
  [key: string]: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_SCHEMA_PATH = path.resolve(here, "../../../spec/authority-profile.schema.json");

let _profile_schema: unknown | undefined;
function profile_schema(): unknown {
  if (_profile_schema === undefined) {
    _profile_schema = JSON.parse(fs.readFileSync(PROFILE_SCHEMA_PATH, "utf8"));
  }
  return _profile_schema;
}

/**
 * undefined path → null; path given but missing → throw; JSON fail → throw with path;
 * schema fail → throw listing all errors.
 */
export function load_profile(file_path: string | undefined): AuthorityProfile | null {
  if (file_path === undefined) return null;
  if (!fs.existsSync(file_path)) {
    throw new Error(`profile file not found: ${file_path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file_path, "utf8"));
  } catch (err) {
    throw new Error(`profile JSON parse failed for ${file_path}: ${String(err)}`);
  }
  const errors = validate_json(profile_schema(), raw);
  if (errors.length > 0) {
    throw new Error(`profile schema validation failed for ${file_path}:\n${errors.join("\n")}`);
  }
  return raw as AuthorityProfile;
}

export function claimed_set(profile: AuthorityProfile | null): Set<string> {
  const set = new Set<string>();
  for (const id of profile?.claimed_invariants ?? []) set.add(id);
  return set;
}

export function resolve_scope_id(
  profile: AuthorityProfile | null,
  action_type: string,
  target: string,
): string | undefined {
  if (!profile) return undefined;
  const key = `${action_type}|${target}`;
  if (profile.scope_decision && key in profile.scope_decision) {
    return profile.scope_decision[key];
  }
  const hit = profile.scope_map?.find(
    (row) => row.action_type === action_type && row.target === target,
  );
  return hit?.scope_id;
}
