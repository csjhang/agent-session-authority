import { createHash } from "node:crypto";
import { canonicalize } from "./jcs.js";

/**
 * Canonical ActionDigest: sha256 of JCS over the four AUTH-02 action-defining fields.
 * All four keys are always present; missing policy_version must be passed as null.
 */
export function action_digest(b: {
  action_type: string;
  target: string;
  args: unknown;
  policy_version: string | null;
}): string {
  const payload = {
    action_type: b.action_type,
    target: b.target,
    args: b.args,
    policy_version: b.policy_version,
  };
  const hex = createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");
  return `sha256:${hex}`;
}
