# Draft wording for Claire - issue #1094

## Proposed update (full A / B / C clarification)

Live claude-agent-acp **0.75.1** now has three related probes: effect-boundary, stale-grant (min B), and stale-effect (min C-stale withhold). Pin remains 0.75.1. Verbose histories stay gitignored; slim witnesses are published.

### A — history replay / session continuity: DEMONSTRATED

**Effect-boundary run (prior):** After restart, the prior Write reappeared with the same native `toolCallId` (`toolu_01WtS7ezV6rN8xLngsz9XWwZ`). That is history replay, not a new execution. Generation-1 create/grant → restart → generation-2 `session_load` is the continuity path.

**Stale-grant / stale-effect runs:** Both re-exercised gen1 create+grant, SIGTERM restart, and gen2 `session_load` before a new Write. A is established; these later runs do not weaken it.

### B — old approval accepted for a new post-restart Write: NOT DEMONSTRATED (UNKNOWN)

**What would demonstrate a B defect:** a genuinely new post-restart Write authorized by the *old* grant with **no** new `approval.request`, plus native auth-state corroboration — not same-`toolCallId` replay.

**Effect-boundary:** the new post-restart Write took a **fresh** approval (`fence_epoch` 2). B untested there.

**Stale-grant live (2026-09-08):** Gen1 grant at seq 7. Orphan inject of the gen1 `request_id` (seq 11) is **not** acceptance evidence (ACP permission responses are server-request initiated). The harness then issued a new Write with a new `toolCallId`/path; a **new** `approval.request` appeared (seq 13) before grant (seq 14). Old grant did **not** silently authorize the new tool call on this path.

**Stale-effect live (2026-09-08):** Same pattern after restart: new Write → **new** `approval.request` (seq 12) → **deny** (seq 13). Again, no silent reuse of the gen1 grant.

**Scoring for Claire:** B remains NOT DEMONSTRATED / UNKNOWN as a stale-grant defect. Observing a new permission request after restart is evidence **against** silent stale authorization on this allow_once / re-approval path on 0.75.1 — **not** proof of a generation-bound fence product-wide.

### C — effect, and C-stale (effect without fresh grant)

**Fresh C (effect-boundary + stale-grant):** Demonstrated when an independently named FS receipt matched after a **new** post-restart approval. Timeout (`-32000`) alone is UNKNOWN; receipts are why fresh C is observable. Do not treat `live_*_ok` as defect or effect proof.

**C-stale (stale-effect live, 2026-09-08):** Goal was whether a new post-restart Write can still land an FS effect when the client **withholds** the new approval (`approval.deny`).

- Gen1: grant=1 (seq 7). Positive-control file present (unrelated).
- Gen2: new unique path `asa-stale-effect-1788838622839-670593.txt`; new `approval.request` then **deny** (seq 12–13).
- Receipt seq 15: `matched=false`, `absent=true`, `withhold=true`. Expected dynamic receipt **absent**. Only the unrelated positive receipt exists.
- Two prompt RPCs timed out (`-32000`); timeout ≠ effect.

**Scoring for Claire:** C-stale is **NOT OBSERVED** on this path (UNKNOWN / earned pause). File absent after withhold + deny means no unexpected effect without a fresh grant was seen here. Frame carefully: **earned pause for C-stale on this allow_once withhold path** — **not** "ACP is safe product-wide."

### Summary table

| Claim | Status on 0.75.1 these harnesses |
| --- | --- |
| A history replay / restart+load | DEMONSTRATED |
| B silent stale grant for new Write | NOT DEMONSTRATED (UNKNOWN); evidence against on allow_once path |
| C fresh authorized effect | DEMONSTRATED (prior runs) |
| C-stale effect after withhold/deny | NOT OBSERVED (UNKNOWN); earned pause on this path |

Slim witnesses: `history-live-effect-witnesses.jsonl`, `history-live-stale-grant-witnesses.jsonl`, `history-live-stale-effect-witnesses.jsonl`.

This is a draft only; do not post automatically to #1094.
