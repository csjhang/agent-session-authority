# Day 3–4 complete — history schema + `asa check`

**Date:** 2026-09-06 (Asia/Taipei)
**Status:** Done

## Checklist

- [x] Repo builds after `pnpm install`
- [x] `spec/history-format.md` — full field table, attrs keys, fail≠info, checker output shape, `not_tested` ≠ `not_declared`
- [x] `packages/core/src/history.ts` — read/write, schema validation, **seq monotonicity** (no silent sort), serialize helper; unknown op/fault warn-or-allow
- [x] `declaration.ts` + `assessment.ts` load profile/assessment
- [x] `cli.ts`: `asa check <history.jsonl> --assessment <path> --profile <path>`
- [x] `report.ts`: capability vectors + claim_status_vector; claim status vs result kept distinct
- [x] Focused vitest coverage for parse / reject / stub label distinction
- [x] Schemas lightly aligned with profile/assessment fields

## Note on later AUTH checkers

AUTH-01 / AUTH-03 / AUTH-05 / AUTH-06 checkers and handwritten corpus landed earlier (ahead of schedule). AUTH-02 / AUTH-04 / AUTH-07 were Stage-2 work. Day 3–4 hardens the history + CLI substrate those checkers consume.
