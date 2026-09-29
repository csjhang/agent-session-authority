# ACP adapter

The default fixture is offline and keeps the core package free of ACP SDKs:

```sh
pnpm --filter @asa/adapter-acp test
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts
```

## Live mode (real peer or offline fake)

Live writes under `targets/claude-agent-acp/results/live-runs/<scenario>/<run-id>/`:

- `history.jsonl` — probe history
- `run.json` — manifest (`mode`, `scenario`, `run_id`, `package_name`, `package_version_pinned`, `package_version_observed`, `run_valid`, `invalid_reasons`, `events` = peer event count, `history_events` = history event count, `notes`)
- `peer-events.jsonl` — one JSON object per line: the raw client-side peer event stream (`result.events`). Use it to re-convert history after converter fixes without re-running live.

CLI flags:

- `--run-id` — default `${Date.now()}-${process.pid}`; must match `^[A-Za-z0-9._-]+$`
- `--out-dir` — default `targets/claude-agent-acp/results/live-runs`

Exit codes (live): `0` when `run_valid` is true; `2` when the run is invalid (version pin miss, etc.) or `write_live_run` refuses to write (bad run id, directory already exists, or output contains an API key / `sk-ant-` pattern).

```sh
# Real peer (requires ANTHROPIC_API_KEY — never commit it)
ANTHROPIC_API_KEY=... pnpm --filter @asa/adapter-acp exec tsx src/cli.ts \
  --mode live --scenario effect --run-id my-run-1
```

### Version pin

After `initialize`, the harness reads `agentInfo.version`. If it is not exactly `0.75.1` (or `agentInfo` is missing / initialize returned no result), **no `session/prompt` is sent**, `run_valid=false`, and `invalid_reasons` explains the mismatch.

### Cancelled vs deny

When the harness replies with ACP outcome `cancelled` because a required option is absent (`allow_always`, `reject_always`, any allow, or any reject), history records `approval.record` with `decision=cancelled`, `client_outcome=cancelled`, and a `reason` — **not** `approval.deny`. An explicit reject option selection remains `approval.deny`.

### Client filesystem methods

`fs/write_text_file` and `fs/read_text_file` are performed for real inside the session cwd. Paths outside the cwd are refused (JSON-RPC `-32602`).

### Secret guard

If `history.jsonl`, `run.json`, or `peer-events.jsonl` text contains the `ANTHROPIC_API_KEY` value (length ≥ 8) or an `sk-ant-…` pattern, `write_live_run` throws and writes nothing.

### Timing options (collect_history only)

`live_observe_ms`, `effect_grace_ms`, and `always_grant_poll_ms` are **`collect_history` options** — there are no CLI flags for them. Defaults: observe 4000ms, effect grace 20000ms, always-grant poll 30000ms. Write-probe `session/prompt` client wait floors at 180s.

### Offline fake agent

The offline fake agent can only be driven through `collect_history` via `live_command` / `live_args`. The CLI has no way to point at a custom agent binary and would start real `claude-agent-acp` if used for live mode.

`test/fixtures/fake-acp-agent.mjs` speaks newline-delimited JSON-RPC on stdio. Drive it with:

```ts
collect_history({
  mode: "live",
  scenario: "effect",
  cwd: tmpDir,
  live_command: process.execPath,
  live_args: [pathToFakeAgent],
  env: { ...process.env, ANTHROPIC_API_KEY: "offline-fake-agent-placeholder", /* ASA_FAKE_* */ },
  effect_grace_ms: 3000,
  always_grant_poll_ms: 3000,
});
```

See `ASA_FAKE_*` comments at the top of the fixture.

## Fixture mode

Fixture output filenames are unchanged: `history-fixture.jsonl`, `history-fixture-<scenario>.jsonl` under `targets/claude-agent-acp/results/` (initialize / capped share `history-fixture.jsonl`).

## Runtime generation in live history

Live histories set `runtime_generation` from the probe's process spawn count (`issuer_id=acp_adapter_live` on `generation.observe`), not from native target generations exposed by claude-agent-acp. AUTH-01b / AUTH-01c evaluated against such histories only validate the probe's own encoding — they do not establish native RuntimeGeneration support on the target.
