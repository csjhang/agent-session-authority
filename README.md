# agent-session-authority

Session Authority Fault Probe — measure cross-runtime session authority invariants (AUTH-01..08). CLI: `asa`.

## Problem

Across people, devices, runtimes, and restarts: **who may act now, who approved what, which action is still valid, and which effect actually happened.**

This repo is a **Fault Probe** (not yet a Conformance Kit). It measures coverage with capability vectors. It does **not** claim a normative industry standard.

## Week-1 scope

- History JSONL format + offline checker (`asa check`)
- Handwritten corpus for AUTH-01, AUTH-03, AUTH-05, AUTH-06 (pass + violate)
- Stub adapters (ACP / AHP / Ably / Dogwood) and stub effect sink
- **No** relay, UI, A2A, Docker, Temporal, or live target SDK deps in `packages/core`

## Authority vocabulary

`ControlLease`, `RuntimeGeneration`, `ActionBinding`, `ActionDigest`, `ApprovalDecision`, `FenceToken` / `FenceEpoch`, `EffectId`, `EffectReceipt`

## Quick start

```bash
pnpm install
pnpm test
pnpm asa -- check corpus/auth01/pass.jsonl --profile corpus/auth01/profile.json
```

CLI:

```text
asa check <history.jsonl> [--assessment path] [--profile path]
```

## Result labels

Capability vectors only (no A0–A3 grade):

| Label | Meaning |
| --- | --- |
| `supported` | Evidence supports the invariant under the stated claim |
| `not_declared` | Target does not claim the invariant |
| `violation` | Counterexample with witness seqs |
| `inconclusive` | Evidence insufficient to judge |
| `underspecified` | Claim too vague to falsify |
| `not_tested` | Checker not implemented / not run (≠ `not_declared`) |

## Layout

```text
spec/                 Profile, schemas, glossary, history format
packages/core         Offline checker + CLI (zero target SDK deps)
packages/sink         Effect sink stub (week-2 expands)
packages/adapters/*   Target adapter stubs
corpus/               Handwritten pass/violate JSONL
```

## License

Apache-2.0
