# Stage 3 results table

(Folder path remains `findings/2026-09-week3/` for history.)

Capability vectors only (no A0–A3 grade). Fixture limitations marked clearly.

| Target | Mode | test_basis | AUTH-01 | AUTH-02 | AUTH-03 | AUTH-04 | AUTH-05 | AUTH-06 | AUTH-07 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic/core corpora | offline `asa check` | synthetic_fixture | supported / violation on corpora | supported / violation | supported / violation | supported / violation | supported / violation | supported / violation | supported / violation | Handwritten pass+violate under `corpus/` |
| claude-agent-acp | FIXTURE | synthetic_fixture | not_tested | inconclusive | not_declared | not_declared | inconclusive | not_declared | not_declared | MockAcpPeer fixture only |
| claude-agent-acp | LIVE capped | live_trace | observe (restart+load) | grant observed | — | partial | — | — | — | `live_capped_ok`; see `LIVE_CAPPED.md` + `history-live-witnesses.jsonl` (seq 27–29 grant; gen2 `session/load` replay; AUTH-04 partial) |
| vscode-agent-host (AHP) | FIXTURE | synthetic_fixture | not_tested | inconclusive | underspecified | not_declared | not_declared | not_declared | not_declared | Multi-client + first-wins confirmation; host-restart generation **not_declared** |
| ably | FIXTURE | synthetic_fixture | not_tested | inconclusive | not_declared | not_declared | inconclusive | not_declared | not_declared | Cloud-only; resume=new invocation; no air-gap |
| acp-mux | FIXTURE | synthetic_fixture | not_declared | inconclusive | not_declared | not_declared | not_declared | not_declared | not_declared | Observation attach + pending re-issue only; **no fencing/lease/digest/generation** |

## Fixture limitations (adapter fixture rows)

- Fixture histories are reconstructed from local mock peers, not live product traces.
- `action_digest` / `fence_epoch` values are **adapter-synthesized** for probe alignment unless noted otherwise.
- `not_tested` ≠ `not_declared` (see profile vocabulary).
- Ably LIVE: needs user `ABLY_API_KEY` later; Stage 3 fixtures do not require it.
- AHP LIVE: needs running VS Code Agent Host + `AHP_WS_URL`; wire capture not in Stage 3 fixtures.
- acp-mux LIVE: not in Stage 3 fixtures.

## Live ACP note

Capped live against `@agentclientprotocol/claude-agent-acp@0.75.1` is documented under `targets/claude-agent-acp/results/LIVE_CAPPED.md`. Verbose `history-live.jsonl` is not published; reproduce with `--mode live --scenario capped`.

## Artifact paths

| Target | Assessment | Vector | History / witnesses |
| --- | --- | --- | --- |
| claude-agent-acp (fixture) | `targets/claude-agent-acp/authority-assessment.json` | `targets/claude-agent-acp/results/capability_vector.json` | `history-fixture.jsonl` |
| claude-agent-acp (live capped) | — | — | `LIVE_CAPPED.md`, `history-live-witnesses.jsonl` |
| vscode-agent-host | `targets/vscode-agent-host/authority-assessment.json` | `targets/vscode-agent-host/results/capability_vector.json` | `history-fixture.jsonl` |
| ably | `targets/ably/authority-assessment.json` | `targets/ably/results/capability_vector.json` | `history-fixture.jsonl` |
| acp-mux | `targets/acp-mux/authority-assessment.json` | `targets/acp-mux/results/capability_vector.json` | `history-fixture.jsonl` |
