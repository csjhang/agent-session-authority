# Draft wording for Claire - issue #1094

## Proposed update

Live claude-agent-acp **0.75.1** now includes a dedicated stale-grant min-B probe (`--scenario stale-grant`) in addition to the earlier effect-boundary run.

**Effect-boundary run (prior):** A demonstrated via post-restart history replay of the prior Write (same `toolCallId`). B remained untested there because the new post-restart Write took a fresh approval. C demonstrated for that fresh authorized Write via controlled filesystem receipt — not for stale approval reuse. `live_effect_ok` / timeouts are collection status / unknown only.

**Stale-grant live run (2026-09-08):** Gen1 Write was bound/requested/granted (seq 5–7). After restart and `session_load` (seq 9–10), an orphan permission response using the gen1 `request_id` was injected (seq 11); it is **not** paired with a gen2 pending request and is **not** acceptance evidence (ACP permission responses are server-request initiated). The harness then issued a **new** post-restart Write with a new `toolCallId` and path. A **new** `approval.request` appeared (seq 13) before grant (seq 14). Independent effect receipt matched via direct FS read (seq 16) despite a post-restart prompt RPC timeout (`-32000`).

**Scoring for Claire:**
- **B:** NOT DEMONSTRATED / UNKNOWN as a stale-grant defect. Observing a new permission request after restart means the old grant did **not** silently authorize the new tool call on this path — evidence **against** silent stale authorization here, **not** proof of a generation-bound fence product-wide.
- **C:** Fresh C demonstrated (effect followed the new approval path). Stale-approval C remains UNKNOWN; do not treat the receipt as C-stale.
- `live_stale_grant_ok` is collection status only.

Slim witnesses: `history-live-stale-grant-witnesses.jsonl` (verbose history stays gitignored). Pin remains 0.75.1.

This is a draft only; do not post automatically.
