# Run reference

## Run statuses

| Status | Meaning | Terminal |
|---|---|---|
| `queued` | accepted, workflow not started | no |
| `planning` | the plan is expanded into scenarios | no |
| `seeding` | the QA tenant is reset and its seed hash checked | no |
| `running` | scenarios are executing | no |
| `canceling` | a cancel was requested | no |
| `completed` | every scenario finished (some may have failed) | yes |
| `failed` | the run itself did not complete (for example an infrastructure or seed problem); read the run and say what it shows | yes |
| `canceled` | stopped by a user | yes |
| `budget_exceeded` | the spend or time ceiling was hit; unfinished scenarios have no verdict | yes |

`wait_run` returns when the status is terminal or when `timeout_s` (default 300, at most 1,800) passes. A timed-out call returns the last state with `timed_out: true`; that is not a result.

## Verdicts

A scenario or step verdict is `pass`, `fail`, `flaky`, `uncertain` or `skipped`.

- `uncertain` means Tessa could not decide. It is never a pass.
- `skipped` carries a `skip_reason` (for example the interface is read-only or unsupported). It is not a pass.
- `flaky` means the attempts of one scenario disagreed.
- The `tier` says who decided: `code` (exact checks), `laya` (local classifier for short texts), `judge` (model judge for long or numeric evidence), `human` (a label by a reviewer).
- `reason_code` is stable and machine readable; `reason` is a short sentence. Quote them.

## Counters and stats

`counters` has `scenarios_total`, `scenarios_done`, `pass`, `fail`, `flaky`, `uncertain`, `skipped`, `steps_recorded`. `stats` adds `pass_hat_k` (the share of scenarios whose k attempts all passed), `flaky_rate`, cost percentiles, latency percentiles, the tier mix, per family numbers and the invariants that need attention. `budget` shows `spent_usd` against `max_usd` and `elapsed_ms` against `max_minutes`.

## Subset runs

`start_run` with `target_id` and `scenario_ids` runs exactly those scenarios (1 to 50, each `accepted` and belonging to the target; otherwise the API answers 422 `scenarios_not_runnable` with the offending ids). Tessa skips the synthetic invariant scenarios and the API fuzz family. The run is marked as a subset (`run.subset` is true). A run never moves a finding to `verifying`; a person or `/tessa:fix` does. Once a finding is `verifying`, Tessa resolves it after any later run, subset or full, in which its scenario runs again and passes. A green subset run is still not a full pass of the suite. Say so.

## Seed reset

A run of a target whose bundle declares a seed starts with the seed gate: Tessa runs the seed's hash command and compares it with the recorded hash. Data written since the last reset (an earlier run, a fix's tests, a person on QA) changes the hash, the run fails with a seed mismatch and no scenario runs. `start_run` with `reset_seed: true` runs the seed reset script first, so the gate checks freshly seeded data; the skills pass it unless the user says not to.

| Answer to `reset_seed: true` | Meaning | Do |
|---|---|---|
| 409 `target_not_ready`, detail `seed_missing` | the bundle declares no seed | start the run once more without `reset_seed` |
| 409 `target_not_ready`, detail `hook_missing` | the seed has no reset script | start the run once more without `reset_seed`; say the data cannot be reset |
| 409 `conflict`, detail `active_run` | another suite or seed run of the target is active | wait for it or ask |
| 409 `production_blocked` | production; seeds are never reset there | the skills never start runs on production |

## Reading a failing step

`get_step` returns the adapter, the verdict with tier and reason, the Tier-0 failures (exact checks that failed), the judge and probe results when any, gold points and database checks, and the request, response and evidence. Each of request, response and evidence is cut at 20 KB (less when the whole result would be too large); `truncated` says which were cut. Artifacts are signed URLs that expire.

## Table template

```
| Scenario | Role | Verdict | Tier | Reason |
|---|---|---|---|---|
| Create issue as staff | staff | fail | code | tier0_failure: expected status 200 |
```

## Errors you may meet

| code | meaning |
|---|---|
| `scenarios_not_runnable` (422) | a scenario of the subset is not accepted; the `details` list its id |
| `target_not_ready` (409) with detail `seed_missing` or `hook_missing` | `reset_seed` asked for a reset the bundle cannot do; see "Seed reset" |
| `team_budget_exceeded` (409) | the team's monthly budget is used up; tell the user, do not retry |
| 403 | the token's user is a viewer; starting runs needs member |
| 409 | the target or run is in a state that refuses the call; quote the message |
| 503 | the workflow engine is unavailable; retry later |

## Production

Runs are never started on a production target from this skill.
