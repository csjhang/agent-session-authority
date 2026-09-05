# agent-session-authority

Session Authority Fault Probe — measure cross-runtime session authority invariants (AUTH-01..08). CLI: `asa`.

This repo is a Fault Probe, not a normative conformance standard. Results are capability vectors with explicit fixture limits.

## Status

- Week 1: history JSONL, `asa check`, AUTH checkers and corpora.
- Week 2: mock sink, AUTH-02/04/07, ACP fixture adapter.
- Week 3: AHP / VS Code Agent Host, Ably AI Transport, acp-mux fixtures; Docker compose; comparison table.

## Quick start

```bash
pnpm install
pnpm test
pnpm asa -- check corpus/auth02/pass.jsonl --profile corpus/auth02/profile.json
```

## Week 3 fixture adapters

```bash
pnpm fixture:ahp
pnpm fixture:ably
pnpm fixture:acp-mux
pnpm fixture:acp
```

Ably live is optional later and requires `ABLY_API_KEY`; fixtures do not. AHP live attach documents `AHP_WS_URL` when a VS Code Agent Host is present. No secrets are committed. `packages/core` stays SDK-free.

## Docker third-party repro

```bash
docker compose -f docker/compose.yaml up
curl http://localhost:8787/health
```

The compose file is a lean mock-sink repro: no Temporal and no relay. See `docker/README.md`.

## Week 3 findings

- `findings/2026-09-week3/writeup.md`
- `findings/2026-09-week3/results-table.md`
- `targets/vscode-agent-host/`, `targets/ably/`, `targets/acp-mux/`

## Result labels

`supported`, `not_declared`, `violation`, `inconclusive`, `underspecified`, and `not_tested` are separate labels; `not_tested` is not `not_declared`.

## License

Apache-2.0
