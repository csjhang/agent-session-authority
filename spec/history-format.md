# History JSONL format

Append-only probe history. `seq` is log index, not cross-process causal order.

## Event kinds

| kind | Meaning |
| --- | --- |
| invoke | Operation started |
| ok | Success completion |
| fail | Guaranteed no effect |
| info | Uncertain / unknown (may have effect) |
| observe | Observation (e.g. generation.observe) |
| fault | Injected or observed fault |

**Critical:** `fail` != `info`.

## Ops

`lease.acquire|renew|release|revoke` · `generation.observe` · `action.propose|bind` · `approval.request|grant|deny|record` · `effect.dispatch|receipt|query` · `session.attach|detach` · `control.handoff`

## Faults

`runtime.restart|crash` · `state.restore` · `net.partition|drop|delay` · `client.disconnect` · `message.duplicate` · `clock.skew`

## Example line

```json
{"seq":1,"ts":"2026-09-05T10:00:00Z","kind":"observe","op":"generation.observe","attrs":{"runtime_generation":1}}
```

## Checker output shape

target, profileVersion, invariant, testBasis, claimStatus, result, witness.seqs, explanation, reproducible
