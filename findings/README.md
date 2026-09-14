# Findings index

Short map of published notes for the Session Authority Fault Probe. Folder names keep historical `week*` / date stamps; root README uses **Stage 1/2/3**.

## Start here

| What | Where |
| --- | --- |
| Probe framing + current live status | [`README.md`](../README.md) |
| Auth→effect chain report | [`targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md`](../targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md) |
| Always-grant live (hardened) | [`targets/claude-agent-acp/results/AUTH_ALWAYS_GRANT_LIVE.md`](../targets/claude-agent-acp/results/AUTH_ALWAYS_GRANT_LIVE.md) |
| Reject-always live (not offered) | [`targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md`](../targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md) |
| Live capped writeup (history replay) | [`targets/claude-agent-acp/results/LIVE_CAPPED.md`](../targets/claude-agent-acp/results/LIVE_CAPPED.md) |
| Slim live witnesses | [`targets/claude-agent-acp/results/history-live-*-witnesses.jsonl`](../targets/claude-agent-acp/results/) |
| Stage 3 comparison table | [`2026-09-week3/results-table.md`](2026-09-week3/results-table.md) |
| Closed outbound issue | [claude-agent-acp#1094](https://github.com/agentclientprotocol/claude-agent-acp/issues/1094) (closed) |
| Option-offer survey (Hermes / OpenClaw; Claude ACP contrast) | [`option-offer-survey.md`](option-offer-survey.md) |

Generation re-ask on pin 0.75.1 is paused. Next probe posture: **option-offer survey** (which permission kinds are actually offered vs listed in the ACP kind enum), then a minimal offline effect-receipt format + verifier — not more silent-across-generation coverage until that survey lands. Survey notes: [`option-offer-survey.md`](option-offer-survey.md).

## By stage / folder

| Stage (README) | Folder | Notes |
| --- | --- | --- |
| Stage 1 (Dogwood generation) | [`2026-09-dogwood-generation/`](2026-09-dogwood-generation/) | [`writeup.md`](2026-09-dogwood-generation/writeup.md), traces, Cedar/Dogwood notes |
| Stage 1 (history + `asa check`) | [`2026-09-day3-4/`](2026-09-day3-4/) | [`README.md`](2026-09-day3-4/README.md) |
| Stage 2 | [`2026-09-week2/`](2026-09-week2/) | [`writeup.md`](2026-09-week2/writeup.md) — mock sink, AUTH-02/04/07, ACP fixture |
| Stage 3 | [`2026-09-week3/`](2026-09-week3/) | [`writeup.md`](2026-09-week3/writeup.md), [`results-table.md`](2026-09-week3/results-table.md) — AHP / Ably / acp-mux fixtures + compose; live ACP capped note |

## Targets

Capability vectors and assessments live under `targets/*/`:

- [`claude-agent-acp`](../targets/claude-agent-acp/) — fixture + live permission-axis (pin 0.75.1)
- [`vscode-agent-host`](../targets/vscode-agent-host/) — fixture
- [`ably`](../targets/ably/) — fixture
- [`acp-mux`](../targets/acp-mux/) — fixture
