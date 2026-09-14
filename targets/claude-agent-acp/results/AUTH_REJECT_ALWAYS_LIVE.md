## Live reject-always run (2026-09-14) — NOT OFFERED / UNDERSPECIFIED

Run identity: pin claude-agent-acp 0.75.1. Exact invocation uses scenario reject-always on the ACP adapter CLI (same pin; provide cloud key in env). CLI exit 0; detach reason `live_reject_always_ok` is **status only** — not effect or defect proof.

Source `history-live-reject-always.jsonl` has 86 lines (gitignored). Slim witness `history-live-reject-always-witnesses.jsonl` (JSON.parse OK). Session `867f7f73-9719-41e7-83e2-f7f2b607723f`.

Key seqs:
- Gen1 option availability: bind seq 12 / approval.request seq 13 for Write `asa-reject-always-positive.txt` (toolCallId `toolu_01Mq42vXY1C5unXBRpqujJdo`) offered **only** allow-once / allow-with-updates (`kind=allow_always`) / reject (`kind=reject_once`). **No `reject_always` / reject-always option.**
- Gen1 approval.deny seq 14 with `option_id` absent / None (strict cancel; no `reject_once` fallback) — correct harness behavior when `pick_reject_always_option` finds nothing.
- Effect receipt notes `reject_always_gen1=false`.
- Gen2 Write `asa-reject-always-1789402802087-895040.txt`: NEW approval.request seq 58, grant seq 59 allow-once, effect_receipt seq 84 `matched=true`, `gen2_approval_requests=1`.

Option absence is data, not a failed test. The same Write offered `allow_always` (allow-with-updates) but did not offer `reject_always` — that durable-deny asymmetry is an observation, not a scoring gap.

### Separated claims (strict)

| Claim | Status |
| --- | --- |
| Option availability (reject_always) | **NOT OFFERED** (definite observation, not inconclusive) |
| Durable-deny symmetry with allow_always | **ABSENT** — same Write offered allow_always (allow-with-updates), did not offer reject_always |
| Silent durable-reject across generation | NOT SCORED (option never present; cannot measure) |
| Spec status | **UNDERSPECIFIED** — ACP lists reject_always as a kind but does not require which kinds must be offered |
| Defect | NOT CLAIMED |

Frame: **reject_always NOT OFFERED** (definite); durable-deny symmetry **ABSENT**; silent durable-reject **NOT SCORED**; ACP kind list **UNDERSPECIFIED** on which options must be offered; defect **NOT CLAIMED**. Repo-first scoring only — draft wording for Claire stays in `ISSUE_1094_WORDING.md`; do not auto-post to GitHub issue #1094.
