# Capped live ACP (2026-09-06)

- Pin: `@agentclientprotocol/claude-agent-acp@0.75.1`
- Detach: `live_capped_ok`
- Session: `57291eff-e580-4f48-8983-85fb5a724b3e`
- Witness JSONL (slim): `history-live-witnesses.jsonl`
- Verbose full `history-live.jsonl` is not published; reproduce with `--mode live --scenario capped` if needed.

## AUTH witnesses
- AUTH-01: RuntimeRestart gen1→gen2; `session/load` + replay ok
- Approval: Write `asa-capped-probe.txt` — `action.bind` / `approval.request` / `approval.grant` (seq 27–29, `fence_epoch: 1`)
- AUTH-04: partial — post-restart write timeout; `session/cancel` method-not-found

## Observation

Restart + `session/load` replayed prior session history (A). The replayed Write uses the same `toolCallId`, so it is not a new execution. A post-restart new Write was pending and then timed out; (B) new-runtime authorization and (C) a new effect are not demonstrated. `generation`/`fence_epoch` are adapter-filled, not proof of native fencing. `live_capped_ok` is collection status, not a successful stale-approval defect reproduction. Insufficient evidence is not “ACP is safe”.

## Separation from effect-boundary run

The later live effect trace is a separate experiment. Its fresh post-restart approval and filesystem receipt do not upgrade the capped trace into stale-approval or stale-effect evidence; live_capped_ok remains collection status only.
