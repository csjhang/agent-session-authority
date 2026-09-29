# Corpus

Handwritten pass/violate JSONL histories for checkers, plus ACP-shaped regenerated fixtures.

| Dir | Invariants | Files |
| --- | --- | --- |
| auth01 | AUTH-01a/b/c | pass.jsonl, pass-two-runtimes.jsonl, violate.jsonl |
| auth02 | AUTH-02 | pass.jsonl, pass-with-unlinked.jsonl, violate.jsonl, violate-markerfree.jsonl, violate-once-grant-reused.jsonl |
| auth03 | AUTH-03a/b/c | pass.jsonl, pass-contended.jsonl, violate.jsonl, violate-handoff-expiry.jsonl, violate-handoff-no-from.jsonl, inconclusive-missing-receipt-ts.jsonl |
| auth04 | AUTH-04 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl, violate-lower-epoch-acquire.jsonl, inconclusive-rejected-only.jsonl, inconclusive-missing-controller.jsonl, inconclusive-no-fence-change.jsonl, inconclusive-unattributed-scope.jsonl |
| auth05 | AUTH-05 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl |
| auth06 | AUTH-06 | pass.jsonl, violate.jsonl, violate-noncommitted-receipt.jsonl |
| auth07 | AUTH-07 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl, violate-late-commit-after-restart.jsonl, violate-reconcile-required-missing.jsonl |
| acp-shaped | AUTH-02 (+ AUTH-01b note) | a1–a7 JSONL via `scripts/generate-acp-shaped-corpus.ts` |

Use (from repo root): `pnpm asa -- check corpus/<dir>/pass.jsonl --profile corpus/<dir>/profile.json`

Paths are relative to cwd. Exit codes: `0` = no violation (post claim-rewrite), `1` = ≥1 violation, `2` = tool error. `--json` emits `build_report` JSON only on stdout.

## Pass corpora (golden)

Every `corpus/**/pass*.jsonl` must produce **no `violation`** on any invariant when checked with that directory's `profile.json`. Do not weaken golden asserts to allow pass-file violations; instead add matching bind/grant (or other supporting events) so the history is clean, or rename/document the file if it is intentionally single-invariant / non-pass.

`auth03/pass.jsonl` has a single holder (no lease contention) → **AUTH-03b inconclusive** (`no lease contention examined`). The positive AUTH-03b example is `auth03/pass-contended.jsonl`.

Intentional non-`pass*.jsonl` single-scenario files (ok to violate other invariants):

- `auth02/pass-with-unlinked.jsonl` — still a `pass*` name; kept free of violations (unlinked receipts → inconclusive, not violation).
- `auth04/inconclusive-*.jsonl`, `auth03/inconclusive-*.jsonl` — inconclusive-focused; not under the pass\* golden.
- `*/violate*.jsonl` — expected violations for the primary invariant(s).

`fail` means guaranteed no effect. `info` means uncertain (unknown) and must not be treated as success.

Marker-based violate corpora remain; marker-only findings must say `test-injected marker`. Each invariant also has ≥1 marker-free violate path (handwritten and/or acp-shaped).

## ACP-shaped path / effect_id

`acp_events_to_history` always normalizes path separators to `/` (including `fs:` effect_id path parts), so Windows-style inputs like `C:\ws\a.txt` never embed backslashes in committed history. Corpus regen is platform-stable for path/`effect_id` fields.
