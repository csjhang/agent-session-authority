# agent-session-authority

Session Authority Fault Probe — measure cross-runtime session authority invariants (AUTH-01..08). CLI: `asa`.

## Problem

Across people, devices, runtimes, and restarts: **who may act now, who approved what, which action is still valid, and which effect actually happened.**

This repo is a **Fault Probe** (not yet a Conformance Kit). It measures coverage with capability vectors. It does **not** claim a normative industry standard.

## Week-2 status

| Slice | Status | Notes |
| --- | --- | --- |
| Mock effect sink | **Done** | `packages/sink` HTTP + ledger, fault inject, snapshot/restore |
| AUTH-02 / 04 / 07 | **Done** | Checkers + pass/violate corpora + golden tests |
| First adapter | **Done** | `packages/adapters/acp` → `@agentclientprotocol/claude-agent-acp@0.75.1` |
| First capability vector | **Done** | `targets/claude-agent-acp/` (FIXTURE) |
| Writeup | **Done** | `findings/2026-09-week2/` |

Week-1 (Dogwood traces, history/asa check, AUTH-01/03/05/06) remains complete.

## Quick start

```bash
pnpm install
pnpm test
pnpm asa -- check corpus/auth02/pass.jsonl --profile corpus/auth02/profile.json
```

### Mock effect sink

```bash
pnpm --filter @asa/sink exec tsx src/cli.ts 8787
# POST http://127.0.0.1:8787/accept  {"effectId":"e1","actionDigest":"d1"}
# GET  /ledger  /health  /observations  /snapshot
# POST /fault   {"mode":"timeout"|"resend"|"lost_reply"|"delay","delayMs":?}
```

### ACP adapter (FIXTURE vs LIVE)

```bash
# FIXTURE — local mock peer, no cloud key
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode fixture

# LIVE — requires user-provided Anthropic API key in env; never commit secrets
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live
```

Pinned package (docs): `@agentclientprotocol/claude-agent-acp@0.75.1` (cards formerly said claude-code-acp / `@zed-industries/claude-agent-acp`).

`packages/core` stays **SDK-free**.

## Authority vocabulary

`ControlLease`, `RuntimeGeneration`, `ActionBinding`, `ActionDigest`, `ApprovalDecision`, `FenceToken` / `FenceEpoch`, `EffectId`, `EffectReceipt`

## Result labels

| Label | Meaning |
| --- | --- |
| `supported` | Evidence supports the invariant under the stated claim |
| `not_declared` | Target does not claim the invariant |
| `violation` | Counterexample with witness seqs |
| `inconclusive` | Evidence insufficient to judge |
| `underspecified` | Claim too vague to falsify |
| `not_tested` | Checker not implemented / not run (**≠** claim_status=not_declared) |

## Layout

```text
spec/                      Profile, schemas, glossary, history format
packages/core              Offline checker + CLI (zero target SDK deps)
packages/sink              Mock effect sink (HTTP + ledger)
packages/adapters/acp      claude-agent-acp adapter (FIXTURE + LIVE gate)
packages/adapters/*        Other target stubs (AHP/Ably/Dogwood)
corpus/                    Handwritten pass/violate JSONL
targets/claude-agent-acp/  Assessment + capability vector
findings/                  Day/week notes
docs/                      Short checklists
```

## License

Apache-2.0
