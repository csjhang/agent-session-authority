# Dogwood Day 1–2 writeup — time window vs generation bound

**Date:** 2026-09-06 (Asia/Taipei)  
**Target:** Dogwood reference interpreter / CLI (`dogwood-policy/dogwood` @ `c6237c88`)  
**Method:** Prefer Dogwood CLI over embedding Rust in ASA core. Synthetic fixtures + official example baseline.  
**Do not pre-claim:** This writeup does **not** assert “Dogwood has an AUTH-01 bug.”

## Day 1 — environment

- Cloned public repo to `/workspace/vendor/dogwood`.
- Installed Rust **1.90.0** via rustup (box system rustc 1.85 was too old for cedar-policy 4.11 / edition 2024 deps).
- Built `amzn-dogwood-cli` → `dogwood` binary.
- Ran official **write_after_read** (SellShares after ApproveSale within 1h): DENY / ALLOW / DENY as documented.
- Also spot-checked `sell_after_approval_valid_ticker`, `write_after_read_formerly`, `read_after_login`.

### Event model — can `RuntimeRestart` be declared?

**Yes.** Guide `03-event-schema.md`:

- Event **kinds are author-chosen** (not reserved): `request`, `response`, `attempt`, `outcome`, `audit`, etc.
- Custom `.dwschema` can mark which kinds are decision points vs history-only.
- Separately, a **Cedar action** (e.g. `RuntimeRestart`) can be added to the action schema and referenced as `Drupe::Action::"RuntimeRestart"::request{…}` under the default request/response/error event schema.

We used the **action** approach for contrast tests (simpler with default event schema). A custom kind would also be feasible (`--event-schema`).

### MFOTL ops (from `04-temporal-expressions.md`)

| Op | Role |
| --- | --- |
| `formerly within <W> <atom>` | Some matching event in the past window |
| `previous within <W> <atom>` | Immediately preceding timepoint only |
| `L since within <W> R` | `L` held at every step after anchor `R` (MFOTL `S`) |
| `!P since … Q` | “Open session” idiom — **no** `P` since `Q` |
| Windows | Mandatory `within` interval (`1h`, `30s`, …); optional max-window directive on event schema |

Default event schema **universally pins principal**: temporal predicates only see same-principal history unless the event schema drops that pin.

### Documented restart behavior (reference interpreter)

README / API guide: built-in `InMemoryTemporalEngine` keeps history **in memory**; **trace is lost after crash/restart**. Production must supply durable temporal storage. This is a **deployment** property of the reference engine, not a silent policy bug.

## Day 2 — contrast tests

Artifacts:

- `time-window.dogwood` — official SellShares←ApproveSale 1h baseline (no restart awareness).
- `generation-bound.dogwood` — same window **plus** `!RuntimeRestart::request{} since within 1h ApproveSale::response{…}`.
- Traces under `traces/`; raw CLI output in `logs/day2-replays.out`.

### Results summary

| Policy | Trace | SellShares verdict | Notes |
| --- | --- | --- | --- |
| time-window | baseline | ALLOW @100 | Matches official write_after_read |
| time-window | restart-in-process | **ALLOW** @300 | Restart event is just history; 1h window still sees prior approval |
| time-window | post-restart-only | **DENY** @300 | Fresh CLI process = empty InMemory history |
| time-window | approval-after-restart | ALLOW @100 | Expected |
| generation-bound | baseline | ALLOW @100 | Generation clause satisfied (no restart since approval) |
| generation-bound | restart-in-process | **DENY** @300 | Generation clause fires — restart since approval |
| generation-bound | post-restart-only | DENY | No approval in fresh history |
| generation-bound | approval-after-restart | **ALLOW** @100 | Approval after restart restores authority |

Reproduce:

```bash
export PATH="/workspace/vendor/dogwood/target/release:$PATH"
ROOT=findings/2026-09-dogwood-generation
dogwood replay $ROOT/time-window.dogwood --policy-schema $ROOT/schema.cedarschema --trace $ROOT/traces/restart-in-process.log
dogwood replay $ROOT/generation-bound.dogwood --policy-schema $ROOT/schema.cedarschema --trace $ROOT/traces/restart-in-process.log
```

## Evidence classification

| Observation | Class | Rationale |
| --- | --- | --- |
| Official SellShares DENY/ALLOW/DENY | **expected** | Matches `write_after_read` expected.out |
| time-window ALLOW across in-process `RuntimeRestart` | **expected** (for that config) | Policy only claims a time window, not generation. Not a declared generation invariant. |
| Fresh-process DENY after “restart” | **expected** / **undeclared-or-config-diff** | Documented InMemory loss; durable backends may differ. Not measured against a production temporal store. |
| generation-bound DENY after restart-in-process | **expected** | Declared via MFOTL `since` + custom restart action; syntax/event-model **feasible**; behavior matches intent |
| generation-bound ALLOW when approval follows restart | **expected** | Same policy |
| “Dogwood has AUTH-01 bug” | **insufficient evidence / do not claim** | AUTH-01 is about cross-runtime session authority. Dogwood can express generation bounds **if** restart (or generation) events are modeled and policies use them. Time-window-only configs do not claim that. Reference engine durability is an explicit non-goal. |

### Valid finding

**If the measured need is only “approval within 1h,” the official time-window config already satisfies it.** Generation / runtime-restart bounding is an **additional** policy+event-model choice, not a missing built-in failure of the SellShares example.

### Optional upstream note (not sent)

Only warranted as a docs/FAQ clarification: “How do I invalidate temporal authority across process restarts?” → (1) durable TemporalEngine, and/or (2) emit a restart/generation event and use `!Restart since Approval` (or re-approve after restart). No upstream issue filed.

## Constraints respected

- No Dogwood SDK deps in `packages/core` — findings/adapters only.
- CLI-only evaluation for these measurements.
