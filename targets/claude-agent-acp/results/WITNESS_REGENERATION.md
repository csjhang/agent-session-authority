# Witness regeneration notes

Version: @agentclientprotocol/claude-agent-acp@0.75.1; source run: 2026-09-06 capped live trace.

The verbose `history-live.jsonl` was absent from the checkout, `/workspace`, and `/home/box/agent-data` during this reliability pass. No events were invented and no live rerun was performed because `ANTHROPIC_API_KEY` was absent from the environment. The published slim file was normalized from its checked-in lines: each physical line was retained as one event when valid JSON; malformed physical lines (previously reported at 5, 8, 19, and 30) retain only recoverable `seq`, `kind`, `op`, and `session_id`, plus an explicit omission note. This is a documented evidence gap for the dropped raw update payloads.

Filter: retain one event per source physical line; preserve ordering and sequence; omit raw payloads only when the source line cannot be parsed. De-identification mapping: `/workspace/agent-session-authority` → `<probe-root>`; `57291eff-e580-4f48-8983-85fb5a724b3e` → `session-A`; `live-session` → `adapter-session-A`. Tool call IDs and sequence numbers are retained for correlation witnesses.

Validation: line-by-line `JSON.parse` and `packages/core` `load_history_file` must both succeed. This artifact demonstrates replay/history observations only, not new-runtime authorization or a new effect.
