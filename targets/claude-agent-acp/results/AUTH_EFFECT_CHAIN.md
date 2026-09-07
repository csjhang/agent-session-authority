# Auth to effect chain report

## Run identity and configuration
Target pin: claude-agent-acp version 0.75.1; native agentInfo.version appears at seq 3 and seq 33.
The live adapter effect scenario was run with generation 1 session creation, restart, generation 2 session load, and a unique post-restart Write.
Source history: history-live-effect.jsonl, 69 records, generated 2026-09-07 17:52 UTC / 2026-09-08 01:52 TST.
Slim witness: history-live-effect-witnesses.jsonl, 8 selected records with original seq values.

## Parsing and witness status
Node line-by-line JSON.parse passed for all 69 full-history records and all 32 slim-witness records.
The core checker loaded the full file before failing on the unrelated ReferenceError observation_guard is not defined in packages/core/src/checker/auth06.ts. That runtime error is not an evidence verdict.
The slim witness is parseable ASA history and preserves relevant native ACP updates plus adapter history records. No events were invented.
The peer did not emit an ACP fs/write_text_file method. The effect boundary is a controlled external filesystem receipt corroborated by the native ACP toolResponse update and a direct read of the resulting file.

## A / B / C score

### A - history replay: DEMONSTRATED
Generation 1 initialized and created the session at seq 1, 3, 14. The positive-control Write was bound, requested, and granted at seq 21-23.
After restart observation seq 31, generation 2 queried the same session at seq 37, reported session-ready and replay at seq 45-46, and returned session load at seq 54.
The prior Write reappeared at seq 47-49 with the same native toolCallId toolu_01WtS7ezV6rN8xLngsz9XWwZ. This is history replay, not a new execution.

### B - old approval accepted in the new runtime: NOT DEMONSTRATED (UNKNOWN)
The old grant is seq 23 in generation 1. The replayed Write at seq 48-49 has that same toolCallId and no new approval request, so it cannot prove a new execution accepted the old grant.
The genuinely new post-restart Write has a different toolCallId toolu_01LpF7UfSMNMKFHrzwWizXuD and its own bind, request, and grant at seq 61-63, with runtime_generation 2 and fence_epoch 2.
This run did not exercise stale approval reuse; absence of a defect is not proof of safety.

### C - new effect: DEMONSTRATED for the fresh authorized Write; stale-approval effect UNKNOWN
The post-restart effect tool response names asa-effect-1788803527069-555734.txt and expected content at seq 65; completion is seq 66. Direct filesystem inspection found exactly asa-effect-receipt-1788803527069-555734.
The positive-control receipt appears at seq 25-26 and was directly read as asa-effect-positive. These are controlled effect receipts, not agent done text.
Both prompt RPCs returned timeout: effect_positive_write seq 30 and effect_post_restart_write seq 67. Timeout alone is unknown; the receipts are why the fresh C result is observable.
The live_effect_ok detach at seq 69 is collection status only, not defect proof. Since the post-restart effect followed a fresh approval, it does not demonstrate an effect caused by the old approval.

## Next minimal experiment
To score stale B/C rather than the fresh positive control, preserve the generation-1 approval request without executing it, restart, then submit that exact old request and digest to generation 2 and capture native authorization state plus an independently named effect receipt.
Do not count same-toolCallId replay, completion text, live_capped_ok, live_effect_ok, or a timeout as new execution or effect evidence.
