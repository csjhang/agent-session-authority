# Corpus

Handwritten pass/violate JSONL histories for checkers.

| Dir | Invariants | Files |
| --- | --- | --- |
| auth01 | AUTH-01a/b/c | pass.jsonl, violate.jsonl |
| auth02 | AUTH-02 | pass.jsonl, violate.jsonl |
| auth03 | AUTH-03a/b/c | pass.jsonl, violate.jsonl |
| auth04 | AUTH-04 | pass.jsonl, violate.jsonl |
| auth05 | AUTH-05 | pass.jsonl, violate.jsonl |
| auth06 | AUTH-06 | pass.jsonl, violate.jsonl |
| auth07 | AUTH-07 | pass.jsonl, violate.jsonl |

Use: `asa check corpus/<dir>/pass.jsonl --profile corpus/<dir>/profile.json`

`fail` means guaranteed no effect. `info` means uncertain (unknown) and must not be treated as success.
