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

Restart + `session/load` can replay a prior Write/approval with no generation-bound fence on that grant.
