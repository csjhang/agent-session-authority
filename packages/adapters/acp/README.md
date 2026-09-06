# ACP adapter

The default fixture is offline and keeps the core package free of ACP SDKs:

```sh
pnpm --filter @asa/adapter-acp test
pnpm --filter @asa/adapter-acp exec tsx src/cli.ts
```

For the capped live probe, provide `ANTHROPIC_API_KEY` in the environment (do not commit it):

```sh
ANTHROPIC_API_KEY=... pnpm --filter @asa/adapter-acp exec tsx src/cli.ts --mode live --scenario capped
```

The capped run writes `targets/claude-agent-acp/results/history-live.jsonl`, performs two short prompts, handles ACP permission/filesystem requests, and exercises a SIGTERM restart plus session restoration when advertised. Without `--scenario`, live mode remains initialize-only.
