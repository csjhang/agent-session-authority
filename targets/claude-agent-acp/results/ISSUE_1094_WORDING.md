# Draft wording for Claire — issue #1094

## Proposed update

We can reproduce post-restart session history restore in version 0.75.1 (capped trace, 2026-09-06). The restored Write uses the same toolCallId, so this demonstrates replay/history (A), not a new execution. A post-restart new Write became pending and timed out. We did not observe (B) an old approval accepted by a new runtime or (C) a new external effect; adapter-filled generation/fence fields are not proof of native fencing.

live_capped_ok is collection status, not a successful stale-approval defect reproduction. Evidence is insufficient to conclude either vulnerability or safety. The smallest follow-up is a fresh post-restart request with a new toolCallId, explicit authorization, and an effect-boundary receipt.

This is a draft only; do not post automatically.
