# Week 3 results table

Capability vectors only (no A0–A3 grade). Fixture limitations marked clearly.

| Target | Mode | test_basis | AUTH-01 | AUTH-02 | AUTH-03 | AUTH-04 | AUTH-05 | AUTH-06 | AUTH-07 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| synthetic/core corpora | offline `asa check` | synthetic_fixture | supported / violation on corpora | supported / violation | supported / violation | supported / violation | supported / violation | supported / violation | supported / violation | Handwritten pass+violate under `corpus/` |
| claude-agent-acp | FIXTURE | synthetic_fixture | not_tested | inconclusive | not_declared | not_declared | inconclusive | not_declared | not_declared | Week-2 MockAcpPeer; LIVE blocked (no ANTHROPIC_API_KEY) |
| vscode-agent-host (AHP) | FIXTURE | synthetic_fixture | not_tested | inconclusive | underspecified | not_declared | not_declared | not_declared | not_declared | Multi-client + first-wins confirmation; host-restart generation **not_declared** |
| ably | FIXTURE | synthetic_fixture | not_tested | inconclusive | not_declared | not_declared | inconclusive | not_declared | not_declared | Cloud-only; resume=new invocation; no air-gap |
| acp-mux | FIXTURE | synthetic_fixture | not_declared | inconclusive | not_declared | not_declared | not_declared | not_declared | not_declared | Observation attach + pending re-issue only; **no fencing/lease/digest/generation** |

## Fixture limitations (all adapter rows)

- Histories are reconstructed from local mock peers, not live product traces.
- `action_digest` / `fence_epoch` values are **adapter-synthesized** for probe alignment unless noted otherwise.
- `not_tested` ≠ `not_declared` (see profile vocabulary).
- Ably LIVE: needs user `ABLY_API_KEY` later; Week 3 does not require it.
- AHP LIVE: needs running VS Code Agent Host + `AHP_WS_URL`; not implemented for wire capture in Week 3.
- acp-mux LIVE: not implemented in Week 3.

## Artifact paths

| Target | Assessment | Vector | History |
| --- | --- | --- | --- |
| claude-agent-acp | `targets/claude-agent-acp/authority-assessment.json` | `targets/claude-agent-acp/results/capability_vector.json` | `history-fixture.jsonl` |
| vscode-agent-host | `targets/vscode-agent-host/authority-assessment.json` | `targets/vscode-agent-host/results/capability_vector.json` | `history-fixture.jsonl` |
| ably | `targets/ably/authority-assessment.json` | `targets/ably/results/capability_vector.json` | `history-fixture.jsonl` |
| acp-mux | `targets/acp-mux/authority-assessment.json` | `targets/acp-mux/results/capability_vector.json` | `history-fixture.jsonl` |
