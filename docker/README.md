# Docker (Week 3)

One-command third-party repro for the mock effect sink. No Temporal / relay / custom Dockerfile.

```bash
docker compose -f docker/compose.yaml up
# elsewhere:
curl http://localhost:8787/health
```

Fixture adapters and `asa check` run on the host with Node >=20 and pnpm (see root README).

Ably live needs `ABLY_API_KEY` later; Week 3 fixtures do not require it.
