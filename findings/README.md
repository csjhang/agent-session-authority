# Findings index

Short map of published notes for the Session Authority Fault Probe. Folder names keep historical `week*` / date stamps; root README uses **Stage 1/2/3**.

## Start here

| What | Where |
| --- | --- |
| Probe framing + live ACP cite | [`README.md`](../README.md) |
| Live capped writeup (history replay; authorization/effect limits) | [`targets/claude-agent-acp/results/LIVE_CAPPED.md`](../targets/claude-agent-acp/results/LIVE_CAPPED.md) |
| Slim live witnesses | [`targets/claude-agent-acp/results/history-live-witnesses.jsonl`](../targets/claude-agent-acp/results/history-live-witnesses.jsonl) |
| Auth→effect chain report | [`targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md`](../targets/claude-agent-acp/results/AUTH_EFFECT_CHAIN.md) |
| #1094 wording draft | [`targets/claude-agent-acp/results/ISSUE_1094_WORDING.md`](../targets/claude-agent-acp/results/ISSUE_1094_WORDING.md) |
| Stage 3 comparison table | [`2026-09-week3/results-table.md`](2026-09-week3/results-table.md) |
| Outbound issue | [claude-agent-acp#1094](https://github.com/agentclientprotocol/claude-agent-acp/issues/1094) |

Biweekly maintainer-status trace on #1094 is owned outside this repo (Align). Do not expand live probe coverage until that signal returns.

## By stage / folder

| Stage (README) | Folder | Notes |
| --- | --- | --- |
| Stage 1 (Dogwood generation) | [`2026-09-dogwood-generation/`](2026-09-dogwood-generation/) | [`writeup.md`](2026-09-dogwood-generation/writeup.md), traces, Cedar/Dogwood notes |
| Stage 1 (history + `asa check`) | [`2026-09-day3-4/`](2026-09-day3-4/README.md) | [`README.md`](2026-09-day3-4/README.md) |
| Stage 2 | [`2026-09-week2/`](2026-09-week2/) | [`writeup.md`](2026-09-week2/writeup.md) — mock sink, AUTH-02/04/07, ACP fixture |
| Stage 3 | [`2026-09-week3/`](2026-09-week3/) | [`writeup.md`](2026-09-week3/writeup.md), [`results-table.md`](2026-09-week3/results-table.md) — AHP / Ably / acp-mux fixtures + compose; live ACP capped note |

## Targets

Capability vectors and assessments live under `targets/*/`:

- [`claude-agent-acp`](../targets/claude-agent-acp/) — fixture + live capped
- [`vscode-agent-host`](../targets/vscode-agent-host/) — fixture
- [`ably`](../targets/ably/) — fixture
- [`acp-mux`](../targets/acp-mux/) — fixture
