# Option-offer survey (Hermes, OpenClaw)

Cheap first-pass: which ACP permission option **kinds** are actually **offered** on a Write (or closest equivalent) versus listed in ACP kind enums. Focus is lasting allow (`allow_always` / allow-with-updates) vs lasting reject (`reject_always`). **No** generation re-ask / always-grant / reject-always restart suites.

Method: public docs + source (preferred). Live initialize+one Write only if offline evidence is thin. Claude ACP pin **0.75.1** appears only as contrast from already-published witnesses in this repo.

Status vocabulary: `observed` (offered on that surface) · `not_offered` (definitely absent on that surface) · `unknown` (needs live/key run) · `underspecified` (kind exists in ACP enum / docs but offer set is not required).

## Summary table

| target | tool/surface | options offered (ids → kinds) | allow_always offered? | reject_always offered? | evidence / notes | status |
| --- | --- | --- | --- | --- | --- | --- |
| **Hermes** (ACP server) | File edit: `write_file` / `patch` via `acp_adapter/edit_approval.py` | `allow_once` → `allow_once`; `deny` → `reject_once` | **no** | **no** | Source builds only those two options. Issue [#29410](https://github.com/NousResearch/hermes-agent/issues/29410) documents asymmetry vs terminal (no session/always on edits). PR #29678 attempted session option; closed without merge as of survey. | `not_offered` (lasting allow + lasting reject on Write) |
| **Hermes** (ACP server) | Dangerous terminal / execute via `acp_adapter/permissions.py` `_build_permission_options` | Default (`allow_permanent=True`, not smart-denied): `allow_once`→`allow_once`; `allow_session`→**`allow_always`** (session-scoped Hermes id, ACP kind reused); `allow_always`→`allow_always`; `deny`→`reject_once`; `deny_always`→**`reject_always`** when SDK accepts that kind | **yes** (wire) | **yes** (wire, if SDK supports `reject_always`) | [permissions.py](https://github.com/NousResearch/hermes-agent/blob/af8d698b/acp_adapter/permissions.py); docs [ACP Host Integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp). Caveat: Hermes maps both `deny` and `deny_always` to internal `"deny"` — lasting reject may not be durable in Hermes semantics even when the ACP option is offered. | `observed` (offer list); lasting-reject **persistence** `underspecified` |
| **OpenClaw** (ACP agent / `openclaw acp`) | Gateway **exec** approval relay (`src/acp/permission-relay.ts`) | Built from Gateway `allowedDecisions`: `allow-once`→`allow_once`; `allow-always`→`allow_always`; `deny`→`reject_once`. Fallback when empty/unknown: **`allow-once` + `deny` only** | **conditional** — included only if Gateway details list `allow-always` | **no** — builder never emits `reject_always` | [permission-relay.ts](https://raw.githubusercontent.com/openclaw/openclaw/main/src/acp/permission-relay.ts); PR [#79337](https://github.com/openclaw/openclaw/pull/79337). Live e2e with `tools.exec.ask=always` observed options `allow-once` + `deny` only. Docs note ACP filesystem / terminal / per-session MCP remain unsupported on this relay path. | `observed` (exec); Write-native surface N/A → see next row |
| **OpenClaw** (ACP agent) | Native ACP filesystem **Write** / edit tool permission | — | unknown / N/A | unknown / N/A | PR #79337: permission relay is **exec-only**; filesystem Write over ACP client capabilities is foundation-only / unsupported for agent-side offer. No Write offer list to survey until that lands. | `unknown` (no Write offer surface yet) |
| **OpenClaw** (ACP **client** resolver) | `resolvePermissionRequest` in `src/acp/client.ts` | Does not **offer**; **selects** among peer options: prefers `allow_once` then `allow_always`; `reject_once` then `reject_always` | accepts if peer offers | accepts if peer offers | Client tests cover always-only peer options. Plugin docs: generic `allow-always` is not auto-persisted unless the plugin stores trust. | selector only (not an offer survey) |
| **claude-agent-acp@0.75.1** (contrast) | Filesystem **Write** (`session/request_permission`) | Live witnesses: `allow-once`→`allow_once`; `allow-with-updates`→`allow_always`; `reject`→`reject_once` | **yes** (`allow-with-updates`) | **no** | Repo witnesses: `targets/claude-agent-acp/results/history-live-always-grant-witnesses.jsonl`, `AUTH_REJECT_ALWAYS_LIVE.md`. Same Write path offers lasting allow but not lasting reject. | `observed` / `not_offered` (reject_always) |

## Plain reading

### Hermes

- **Write / edit path is the cheap answer for this survey:** Hermes ACP file edits (`write_file`, `patch`) offer only **allow once** and **deny once**. There is no lasting allow and no lasting reject on that surface in current public source.
- **Terminal / execute** is richer: lasting allow appears both as session-scoped `allow_session` (ACP kind still labeled `allow_always`) and true permanent `allow_always` when permanent approvals are enabled. A `deny_always` option with kind `reject_always` is appended when the installed ACP SDK accepts that kind — but Hermes currently maps `deny_always` to the same internal deny string as one-shot deny, so “offered on the wire” ≠ “durable reject in Hermes.”
- Live Hermes ACP run is **not required** for the Write option-offer claim; source + maintainer issue are enough. A live key run would only confirm the same two-option edit dialog in a host UI.

### OpenClaw

- As an **ACP agent**, OpenClaw’s surveyed permission surface today is **Gateway exec approval relay**, not a filesystem Write tool. That builder can advertise lasting allow when Gateway `allowedDecisions` includes `allow-always`; it **never** builds `reject_always`. Conservative fallback and published live e2e both showed **allow-once + deny** only.
- There is **no** surveyed native Write offer list yet (filesystem ACP execution unsupported on the agent relay). Treat Write as `unknown` / not applicable until OpenClaw exposes edit/Write through `session/request_permission`.
- As an **ACP client**, OpenClaw can *accept* `allow_always` / `reject_always` if a peer offers them; that is selection behavior, not an offer set.

### Contrast (Claude ACP 0.75.1 only)

Already measured in-repo: Write offers lasting allow (`allow-with-updates` / `allow_always`) and one-shot reject, but **not** `reject_always`. That durable-allow-without-durable-reject asymmetry is the closest published live witness; Hermes Write is even narrower (no lasting allow either).

## What still needs a live / key run

| Target | Blocking | Exact next command (when keys/setup exist) |
| --- | --- | --- |
| Hermes edit Write | Optional confirmation only; offline source is solid | Install Hermes ACP extra; run `hermes acp` under an ACP host or thin SDK client; prompt one `write_file`; log `session/request_permission` `options`. Needs Hermes provider credentials in `~/.hermes`, not this repo’s Anthropic pin. |
| Hermes terminal | Confirm `deny_always` appears with your SDK version and whether selecting it persists | Same ACP session; trigger a dangerous terminal approval with `allow_permanent=True`; inspect options; optionally select `deny_always` and re-issue matching command. |
| OpenClaw exec | Confirm when Gateway includes `allow-always` in `allowedDecisions` | `openclaw gateway` with exec ask mode that advertises allow-always; `openclaw acp`; ACP client that logs permission options (pattern from PR #79337 e2e). Needs OpenClaw Gateway setup; LLM can be mocked. |
| OpenClaw Write | Blocked until product exposes ACP filesystem Write permissions | No command yet — surface absent per #79337 notes. |
| Restart / silent lasting grant or reject | **Out of scope** for this survey (Align paused generation re-ask) | Do not run always-grant / reject-always across restart here. |

## Evidence pins (retrieved for this pass)

- Hermes edit options: [`acp_adapter/edit_approval.py`](https://github.com/NousResearch/hermes-agent/blob/72ff3e90/acp_adapter/edit_approval.py) (`PermissionOption` allow_once + deny only).
- Hermes terminal options: [`acp_adapter/permissions.py`](https://github.com/NousResearch/hermes-agent/blob/af8d698b/acp_adapter/permissions.py) (`_build_permission_options`).
- Hermes docs: [ACP Host Integration — Approvals](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp).
- Hermes edit asymmetry report: [NousResearch/hermes-agent#29410](https://github.com/NousResearch/hermes-agent/issues/29410).
- OpenClaw offer builder: [`src/acp/permission-relay.ts`](https://raw.githubusercontent.com/openclaw/openclaw/main/src/acp/permission-relay.ts).
- OpenClaw relay + live option ids: [openclaw/openclaw#79337](https://github.com/openclaw/openclaw/pull/79337).
- Claude ACP contrast (this repo): `targets/claude-agent-acp/results/AUTH_REJECT_ALWAYS_LIVE.md`, always-grant witnesses JSONL.

## Non-goals

- No full restart suites; no silent-across-generation scoring.
- No GitHub issue posts from this survey.
- No claim that ACP enum membership implies a product must offer every kind.
