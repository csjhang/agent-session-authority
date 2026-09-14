## Live always-grant run (2026-09-14, hardened waits) - A / B / C-always score

Run identity: pin claude-agent-acp 0.75.1 (agentInfo.version at seq 3 and seq 23). Exact invocation uses scenario always-grant on the ACP adapter CLI (same pin; provide cloud key in env). Hardened waits: prompt_timeout_ms=180000 with FS / tool_call poll before scoring the receipt.

Source history-live-always-grant.jsonl has 57 lines (gitignored; CLI exit 0). Slim witness history-live-always-grant-witnesses.jsonl has 12 records (JSON.parse OK). Session 8a6f9814-99e5-4185-b181-dcd8a08750df. Collection status live_always_grant_ok at seq 57 is status only — not effect or defect proof.

Key seqs:
- Gen1 option availability: bind seq 15 offered allow-once / allow-with-updates (kind=allow_always) / reject; approval.request seq 16 same options; approval.grant seq 17 with option_id=allow-with-updates, option_kind=allow_always, fence_epoch=1, toolCallId toolu_01LcK1EGaQqtwTLvyVPetXgt.
- Restart boundary: initialize_result seq 23, session_load seq 30 (same session id).
- Gen2 NEW Write: bind seq 38 (path asa-always-grant-1789400531536-873578.txt, toolCallId toolu_01F85165sBeRBzWDLoYu7LY2); **NEW** approval.request seq 39; approval.grant seq 40 with option_id=allow-once, option_kind=allow_once (harness gen2 uses pick_allow_option_id).
- Effect receipt ~seq 56: sink=direct_fs_read, path=asa-always-grant-1789400531536-873578.txt, content matched expected, matched=true, allow_always_gen1=true, gen2_approval_requests=1, prompt_timeout_ms=180000.

Contrast only (superseded): an earlier pre-hardening always-grant run on this pin recorded gen2_approval_requests=0 and matched=false / absent=true under short timeouts. That UNKNOWN-effect candidate is **superseded** by this hardened run — cite it only as contrast, not as the live score.

### Separated claims (strict)

| Claim | Status | Basis |
| --- | --- | --- |
| Option availability (allow_always offered+selected) | **DEMONSTRATED** | seq 15–17: allow-with-updates / kind=allow_always offered and granted |
| Silent always-allow across generation (zero gen2 re-ask) | **NOT OBSERVED** | Gen2 emitted NEW approval.request seq 39; receipt notes gen2_approval_requests=1 |
| Re-ask after gen1 allow_always | **DEMONSTRATED** | seq 39 request + seq 40 allow_once grant for new toolCallId |
| Effect / FS after fresh gen2 grant | **DEMONSTRATED** | seq 56 matched=true via direct FS read after seq 40 grant |
| Defect (always-allow silently authorizing across generation) | **NOT CLAIMED** | Re-ask demonstrated; do not claim defect or C-always silence |

### A - session continuity / restart path: DEMONSTRATED (limited)

Gen1 create+allow_always grant, SIGTERM restart, gen2 session_load, then a post-restart Write. Same-toolCallId history replay remains from the earlier effect-boundary run. A here is restart+load under the always-grant harness.

### B / always-allow across generation: NOT OBSERVED (re-ask demonstrated)

Silent always-allow across generation would require a new post-restart Write with **zero** gen2 approval.request after gen1 allow_always, plus an FS receipt under that silence. Observed: gen2 emitted a **new** approval.request (seq 39) before grant (seq 40). Gen1 allow_always did **not** silently cover the new toolCallId on this path. Aligns with allow_once stale-grant / stale-effect contrast on the same pin (those also re-asked). Frame carefully: evidence **against** silent cross-generation always-allow on this hardened path — **not** product-wide fence proof.

### C-always - effect under allow_always without re-ask: NOT DEMONSTRATED (NOT OBSERVED)

C-always (silence + effect) was not observed. What **was** demonstrated: FS effect after a **fresh** gen2 allow_once grant (seq 40 → seq 56 matched=true). That is fresh authorized C, not C-always under silence. live_always_grant_ok and prompt timing are not defect proof.

Frame: **option availability demonstrated; re-ask demonstrated; FS effect after fresh gen2 grant demonstrated; silent always-allow across generation NOT OBSERVED; do not claim defect.** Repo-first scoring only — draft wording for Claire stays in ISSUE_1094_WORDING.md; do not auto-post to GitHub issue #1094.
