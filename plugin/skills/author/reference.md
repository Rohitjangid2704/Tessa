# Author reference

## What goes where

```
tessa/
  scenarios/<feature_id>/<slug>.yaml   one scenario per file; the main output
  oracle/<name>.sql or <name>.py       only when a cell needs an expected value computed from data
  oracle/<name>.yaml                   the oracle's declaration (parameters, columns)
  seeds/                               only when a scenario needs fixture data that does not exist yet
  flows/<id>.yaml                      only for a new key UI path a browser scenario needs
```

The format of every file, and the closed vocabulary of names (features, roles, interfaces, oracles, tools, environment variables), comes from the text `issue_prompt` returns; the JSON Schema it names is the authority. Existing files other than scenario files are not edited. If a scenario needs an oracle that does not exist and you can write one, add it as a new file and say so in the report.

Scenario header, in this order: `schema_version: 1`, `id`, `title`, `feature_id`, `family`, `role`, `interface_id`, `timeout_seconds` (optional), `authored_from` (the prompt id), `steps`. The `id` is `<feature_id>.<slug>` and never changes when you edit the file later: an existing file is edited in place and keeps its `id`, so Tessa records a new version instead of a duplicate.

## Choosing the work

| Source | Tool | Use |
|---|---|---|
| Ticked items | `get_proposal` with `status: "selected"` | pass the item `id` values as `proposal_item_ids` |
| Cells that need authoring | `get_coverage` with `status: "needs_author"` | pass the cell `id` values as `cell_ids` |

Send exactly one of the two lists, at most 50 ids. An item maps to coverage cells (`cell_count`); the prompt covers those cells and says why each item matters. An item becomes `authored` when an imported scenario file answers the prompt for it and fits its feature and interface.

## Errors of the prompt call

| Code | Meaning | Do |
|---|---|---|
| `proposal_item_not_found` | the proposal changed since you read it | `get_proposal` again, pick again |
| `item_has_no_authorable_cells` | the item's features map to no cell | skip it, tell the user |
| `too_many_cells` | the items map to more cells than one prompt takes | split into rounds |
| `target_not_ready` | the target has no valid bundle | `/tessa:discover` first |

## Local checks

Run them before `validate_bundle`. Their purpose is to catch expectations that are wrong on real data, which the server cannot know.

1. Oracle SQL. Show the statement. Run it as a read-only SELECT (for example `BEGIN READ ONLY; ...; ROLLBACK;` or the repository's read replica client) against the dev or QA database. Compare the first rows with the `expect_db` or `gold_from` the scenario uses. A parameter placeholder is filled with the value from the scenario, not guessed.
2. Seed script. Show it and what it writes. It runs only on dev or QA, after the user agrees, then run the oracle again on the seeded data. If the manifest declares a `cleanup` for a write feature, run it afterwards and check the rows are gone.
3. One flow. Drive the first steps of one new scenario with the repository's own Playwright config or HTTP client against the dev or QA app. A browser scenario that cannot reach a stable selector or text locally will not pass its dry run either.

A host or database name containing `prod`, `production` or a customer's domain is not dev or QA until the user says so. Credentials stay in the environment of the process that runs the command; never place one in an argument or in the chat.

If a check cannot run, the final report says "not run locally: <check>, <reason>". That is information, not a failure.

## After the upload

`upload_bundle` returns `scenarios_imported` and `dry_run_run_id`. Tessa validates each scenario file against the bundle, reports a problem per file without rejecting the others, puts the valid ones in the review queue, and dry-runs them twice (a run of kind `generate`). The scenario status afterwards is what `list_scenarios` shows:

| Status | Meaning |
|---|---|
| `in_review` | valid and dry-run; waits for a person to accept or reject |
| `invalid` | the server rejected this file; `first_error` says why |
| `accepted` | a person accepted it |
| `quarantined`, `rejected`, `retired` | decided by a person or by the flakiness policy |

You never accept, reject or retire a scenario. There is no tool for it by design.

A dry run that failed on a scenario means the expectation was not true twice in a row, or the app does not behave the way the code suggested. Read the failing step with `get_step`, quote what was sent and what came back, fix the scenario, validate and upload again; a new upload is a new bundle version.

## Report shape

```
Scope      <n> items / <m> cells (names)
Written    <files>, by kind
Checked    oracle SQL <ok | not run: reason>, seed <...>, flow <...>
Uploaded   bundle v<k>, <scenarios_imported> scenarios, dry run <run id> <status>
In review  <n>   Invalid <n> (first_error each)   Failed dry run <n>
Items now  <titles> authored (as get_proposal returned)
Next       review the scenarios on the Review page; accept or reject each
```
