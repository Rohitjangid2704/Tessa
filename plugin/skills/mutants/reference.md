# Mutants reference

## `tessa/mutants.yaml`

One YAML list, UTF-8, 2-space indent, one document, no anchors. Written on the starting branch, never on a mutant branch. It travels with the bundle (`upload_bundle`) and registers the mutants; uploading the same `name` again updates the entry. The schema of one entry is `schemas/mutant.v1.json`; a key it does not know is an error.

| Key | Rule |
|---|---|
| `name` | the slug of the bug, equal to the last part of the branch name; unique per app |
| `branch` | the full branch name, `tessa/mutant/<slug>`, at most 200 characters |
| `description` | what the branch breaks, one or two sentences a QA engineer understands; no secrets or personal data |
| `expected_catchers` | 1 to 20 invariant ids, without repeats, that SHOULD fail when the bug is present; an unknown id is rejected |
| `deployed_marker` | optional `{path, expected_text}`: a path on the deployed mutant that starts with `/`, and text its body contains only on this branch |
| `base_url` | leave it out; it exists only after someone deploys the branch and is entered in Tessa then |

```yaml
- name: skip-tenant-filter-on-issue-list
  branch: tessa/mutant/skip-tenant-filter-on-issue-list
  description: The issue list query no longer filters by tenant, so a user sees issues of other hotels.
  expected_catchers:
    - tenant_isolation
    - count_consistency
  deployed_marker:
    path: /__qa/mutant
    expected_text: skip-tenant-filter-on-issue-list
```

## Built-in invariants

Pick the ones whose rule the code can plausibly break while the app keeps working. Ids of the bundle's own `invariants` section are also valid.

| Id | A realistic bug breaks it by |
|---|---|
| `tenant_isolation` | dropping the tenant or hotel filter from one query |
| `auth_boundaries` | skipping the authentication or permission check on one route |
| `role_monotonicity` | granting a lower role something only a higher role may do |
| `idempotent_writes` | ignoring the idempotency key on one write route |
| `pii_by_role` | returning an unmasked field to a role that must not see it |
| `count_consistency` | an off-by-one or a wrong filter in a total |
| `empty_set_honesty` | answering success text on an empty result |
| `no_internal_ids` | leaking an internal id in a response |
| `no_5xx` | an unguarded null or division on a rare input |
| `no_console_errors` | a client call that logs an error |
| `latency` | a missing index or an N+1 loop |
| `accessibility` | removing a label from a control |
| `no_save_claim_before_confirm`, `external_facts_labelled`, `refuses_out_of_scope`, `injection_resistance`, `authority_pressure` | llm-app invariants; only for apps with an assistant |

If `issue_prompt` answers `unknown_invariant`, the id does not exist for this target; ask the user for the correct list.

## Branch rules

- Name: `tessa/mutant/<slug>`; slug lowercase letters, digits and `-`, at most 60 characters, names the bug.
- Base: the branch QA is deployed from, never another mutant. One commit.
- Minimal diff: usually one line or one condition. Realistic: a mistake a developer could really make. Builds, starts, passes its health check and the happy path.
- Never merged, rebased, cherry-picked or opened as a pull request. If the user asks you to push, push only under the mutant's own name.
- Deployed marker: strongly recommended where the app has QA-only routes behind a flag that is off by default. Tessa reads the marker before a run; when the text is missing it records the run as errored (not deployed) and never as survived, so a forgotten deploy cannot look like a blind spot of the suite.

## Report shape

```
Branch                              Change (file:line)        Expected catchers          Marker
tessa/mutant/skip-tenant-...    app/issues.py:88          tenant_isolation           /__qa/mutant
```

Then: `mutants_imported` from the upload, and the steps the user does next (deploy, enter the URL, start the mutation run on the Mutation page).

## Production

A target with `tier: production` gets no mutants: no `issue_prompt`, no branch, no `upload_bundle`. Say so and stop.
