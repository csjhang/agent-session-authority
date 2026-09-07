# Auth → effect chain report

## Version and configuration

- Target: `@agentclientprotocol/claude-agent-acp@0.75.1`.
- Run: capped live trace, `--mode live --scenario capped`, 2026-09-06; `test_basis: live_trace`.
- Witness: `history-live-witnesses.jsonl`; verbose `history-live.jsonl` was unavailable.
- Generation/fence fields are adapter-filled (`derived`/`test-injected`), not native fencing evidence.

## Evidence inventory

The slim witness contains initialize/session creation, Write approval request/grant (seq 27–29), RuntimeRestart generation observation (seq 40), session/load replay, a replayed Write with the same `toolCallId`, and a post-restart new Write pending at seq 68 followed by timeout at seq 69. Malformed source lines 5, 8, 19, and 30 were normalized with raw payloads omitted; see `WITNESS_REGENERATION.md`.

## Demonstrated vs unknown

- Demonstrated (A): post-restart session history restore/replay.
- Not demonstrated (B): an old approval accepted authorization in the new runtime.
- Not demonstrated (C): a new effect caused by that old approval. The replayed Write is the same tool call, not a new execution; the new Write timed out and has no effect receipt.
- `live_capped_ok` is collection status, not successful stale-approval defect reproduction. Unknown is not “safe”.

## Commands and next minimal experiment

The capped adapter command was the live scenario with the dependency pinned above. The follow-up must obtain a new toolCallId, explicit post-restart authorization, effect-boundary observation, and external receipt. Record native wire fields separately from adapter-derived fields. A timeout remains unknown; do not infer an effect.
