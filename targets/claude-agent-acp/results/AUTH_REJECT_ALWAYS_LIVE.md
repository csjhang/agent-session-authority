## Live reject-always run — not run yet

Pin: claude-agent-acp 0.75.1. Scenario: `--scenario reject-always`.

This stub exists so the harness docs and always-grant contrast have a landing place for a future live score. Do **not** invent A / B / C-reject results here until a live Anthropic run is collected and witnessed.

Expected live artifacts (when run):
- `history-live-reject-always.jsonl` (gitignored verbose stream)
- Slim witness `history-live-reject-always-witnesses.jsonl`
- Scoring against the Reject-always checklist in `AUTH_EFFECT_CHAIN.md`

Harness reminder: gen1 must select `reject_always` / `reject-always` strictly (no `reject_once` fallback). Gen2 uses default allow to observe re-ask vs silent durable-reject across generation.
