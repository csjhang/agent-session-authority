# Corpus

Handwritten pass/violate JSONL histories for checkers, plus ACP-shaped regenerated fixtures.

| Dir | Invariants | Files |
| --- | --- | --- |
| auth01 | AUTH-01a/b/c | pass.jsonl, violate.jsonl |
| auth02 | AUTH-02 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl |
| auth03 | AUTH-03a/b/c | pass.jsonl, violate.jsonl, violate-handoff-expiry.jsonl |
| auth04 | AUTH-04 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl |
| auth05 | AUTH-05 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl |
| auth06 | AUTH-06 | pass.jsonl, violate.jsonl, violate-noncommitted-receipt.jsonl |
| auth07 | AUTH-07 | pass.jsonl, violate.jsonl, violate-markerfree.jsonl |
| acp-shaped | AUTH-02 (+ AUTH-01b note) | a1–a6 JSONL via `scripts/generate-acp-shaped-corpus.ts` |

Use: `asa check corpus/<dir>/pass.jsonl --profile corpus/<dir>/profile.json`

`fail` means guaranteed no effect. `info` means uncertain (unknown) and must not be treated as success.

Marker-based violate corpora remain; marker-only findings must say `test-injected marker`. Each invariant also has ≥1 marker-free violate path (handwritten and/or acp-shaped).
