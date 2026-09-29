/**
 * Re-export JCS canonicalize from @asa/core (moved in PR-2).
 * Spec vector imports of ./jcs.js stay unchanged.
 */
export { canonicalize, containsLoneSurrogate } from "../../../packages/core/src/jcs.js";
