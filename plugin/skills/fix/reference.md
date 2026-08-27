# Fix reference

## What the skill needs from Tessa

| Need | Tool | Field |
|---|---|---|
| The finding, its status and class | `get_finding` | `finding.status`, `finding.class`, `finding.invariant_id` |
| The scenario to re-run | `get_finding` | `finding.scenario_id` (null when no scenario produced the finding, for example a `contract` finding) |
| The target and its tier | `get_target` | `target.tier` (`production` blocks the skill) |
| The cause the team agreed on | `get_finding` | latest explanation: `created_at`, `structured.opinion`, `root_cause`, `files`, `commit` (the commit that introduced the defect, absent when it is not known; never the code the explanation was read at), `confidence` |
| The next status before the re-run | `move_finding` (write) | `in_fix` when the fix starts, `verifying` once the fix is live on QA and the user confirmed the re-run |
| The re-run | `start_run` (write) | `target_id` plus `scenario_ids` with the one scenario id, and `reset_seed: true` so the seed gate checks freshly seeded data instead of failing on what earlier runs and the fix's tests wrote; without a seed or a reset script (409 `target_not_ready`, detail `seed_missing` or `hook_missing`) start it once more without `reset_seed` |
| The result | `wait_run`, `get_run` | scenario verdict, counters, `failing_steps` |
| The proof of a failure | `get_step` | request, response and evidence, each cut at 20 KB |
| The status after the re-run | `get_finding` | `finding.status` as the API set it: `resolved` after a pass, `in_fix` after a new occurrence |

## What a subset run is

`start_run` with `target_id` and `scenario_ids` (1 to 50 accepted scenarios of the target) runs only those scenarios. It skips the invariant scenarios and the API fuzz family by design. The run is labelled `Subset` and `From Claude Code` in the Tessa web app. A passing subset run proves the scenario now passes; it does not prove nothing else broke.

A run never moves a finding to `verifying`; this skill does, before the re-run. A run whose scenarios ran, subset or full, triages its findings before it reports its terminal status. The triage resolves a `verifying` finding whose scenario ran again and passed, and a new occurrence of the finding moves it from `verifying` back to `in_fix`. So once `wait_run` returns, `get_finding` shows the outcome, and the skill leaves the finding there.

An error `scenarios_not_runnable` names each scenario id with a detail code: `scenario_not_accepted` (for example `in_review` or `quarantined`; it must be accepted in the Tessa web app first), `scenario_synthetic` (an active invariant or API fuzz scenario, which only a full run covers), `scenario_not_found`, `scenario_has_no_cell` or `scenario_not_in_bundle`. Report it and stop.

## Status moves this skill may make

| From | To | When |
|---|---|---|
| `new`, `triaged`, `verifying` | `in_fix` | the fix is started |
| `in_fix` | `verifying` | the fix is live on QA and the user confirmed the re-run, just before `start_run` |

It never moves the finding after the re-run and never sets `resolved`, `dismissed` or `known_gap`. If the user wants `dismissed` or `known_gap`, they say so and you call `move_finding` with exactly that status (`known_gap` needs a reason of 3 to 500 characters).

## Branch and commit

- Branch: `fix/<first 8 characters of the finding id>`, created from the branch the user is on, with `git switch -c`.
- Commit message: first line names the cause in under 72 characters; the body names the finding id and the test that covers it.
- Never push, merge, rebase or force. The user decides.

## Report shape

```
Finding   <id> <title>
Branch    fix/<short id> at <commit>
Change    <one line>
Re-run    <run id>  <verdict>  (subset: invariants and API fuzz skipped)
Status    <finding status as get_finding returned it>
```

If the re-run failed, add the reason code and the quoted step output under the `Re-run` line; the `Status` line still shows what the API set.
