import fs from "node:fs";
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
  notes?: string;
  [key: string]: unknown;
}

export function load_profile(path: string | undefined): AuthorityProfile | null {
  if (!path) return null;
  if (!fs.existsSync(path)) return null;
  return JSON.parse(fs.readFileSync(path, "utf8")) as AuthorityProfile;
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
