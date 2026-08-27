# Propose reference

## The file

`tessa/proposal.yaml` at the repository root, UTF-8, 2-space indent, one YAML document, no anchors or aliases, at most 256 KiB. The authority is the schema `GET /schemas/proposal.v1.json`; `put_proposal` checks it for you. A key the schema does not know is an error.

Header, in this order:

| Key | Value |
|---|---|
| `schema` | the schema URL the prompt gives, copied exactly |
| `target_token` | the `target_token` of the prompt (the same as `manifest.yaml`) |
| `generated_at` | now, ISO 8601 with a UTC offset, for example `2026-10-08T09:30:00Z` |
| `source` | `commit` (`git rev-parse HEAD`, 7 to 40 lowercase hex), `branch` (`git branch --show-current`, leave out on a detached head), `dirty` (true when `git status --porcelain` prints anything) |
| `authored_from` | the `issue_id` returned by `issue_prompt` |
| `items` | 1 to 200 entries, riskiest first; 15 to 40 is usual |

The `source` of the proposal is its own section. It is not the `source` of `manifest.yaml`, which you do not touch.

## An item

| Key | Rule |
|---|---|
| `key` | stable slug, 3 to 80 characters, `a-z`, `0-9`, `_`, `.`, `-`, starting with a letter or digit; unique in the file; reuse the previous key for the same item |
| `title` | one line a person understands, at most 120 characters |
| `area` | an area name of the catalog, spelled exactly |
| `feature_ids` | 1 to 20 feature ids of the catalog; one that is not in the latest bundle lowers the item's confidence |
| `interface_id` | optional; one interface of the manifest when the item targets only that one |
| `kind` | `api`, `browser`, `stream`, `webhook`, `pipeline`, `contract` or `integration` |
| `risk` | `high`, `medium` or `low` |
| `reasons` | 1 to 6 of `{code, note?}`; each code at most once; `note` at most 300 characters and says what you found |
| `needs` | optional list from `seed`, `db_read`, `hook`, `flag`, `fixture`, `credentials` |
| `depth` | `smoke`, `standard` or `deep` |
| `estimate` | optional `{scenarios: 1..50, minutes: 1..600}` for one run |
| `confidence` | `low` (inferred, did not read all of it), `medium` (read the main code path), `high` (read the code and its tests) |
| `evidence` | optional, at most 500 characters: files, symbols and commits behind the reasons |

## Reason codes and where to look

| Code | Look at | A real finding looks like |
|---|---|---|
| `recent_change` | `git log --since=... --stat`, `git diff --stat <previous commit>..HEAD` | "14 commits and 600 changed lines in app/billing since the last proposal" |
| `no_unit_tests` | the test folder next to the code, `git ls-files` for `test_*`, `*.spec.*`, `__tests__` | "no test file imports app/billing/refunds.py" |
| `auth_path` | login, session, role, permission, tenant filter code | "role check in middleware/auth.py gates 9 routes" |
| `money_path` | payments, refunds, invoices, pricing, quotas | "refunds.py calls the payment provider" |
| `migration` | migration folders, recent or destructive ones | "migration 0042 drops a column of payments" |
| `complexity` | very large modules, deep branching, state machines, concurrency | "orders/state.py has 11 states and 40 transitions" |
| `bug_history` | commit messages with fix, bug, hotfix or revert on the same paths | "5 fix commits on app/search in 90 days" |
| `external_dependency` | calls to another service, queue, webhook or third party | "app/sync.py posts to the PMS API" |
| `user_visible` | flows a customer sees directly | "checkout page" |

## How to rank

- `high`: a defect would lose or corrupt data or money, expose another tenant's data, break login or permissions, or stop a core flow for every user.
- `medium`: a defect would break a feature for some users or give wrong results people can notice and work around.
- `low`: cosmetic or rarely used behaviour.
- Raise the risk of an area that changed recently, has no tests and touches money or permissions. Lower it for an area that is small, stable and well covered by tests you read.

## Keeping keys stable

`get_proposal` with `keys_only: true` lists the previous `key`, `title`, `area` and `status`. For every item that still stands:

- reuse the key unchanged, even if you would title it differently now;
- an item with status `selected` or `declined` keeps its key so the team's choice and note carry over; Tessa carries ticks, notes and authored scenarios over to items that keep their key;
- an item whose area was fixed in code, or that no longer exists, may be dropped; say which in the report;
- a genuinely new item gets a new key that does not collide with an old one.

## Example

```yaml
schema: http://localhost:8000/schemas/proposal.v1.json
target_token: tgt_abcdefghijklmnopqrstuv
generated_at: 2026-10-08T09:30:00Z
source:
  commit: 3f9c2ab41d7e
  branch: main
  dirty: false
authored_from: 7b1d2c3e-1111-4222-8333-444455556666
items:
  - key: billing.refund.partial
    title: Partial refunds after a cancelled stay
    area: Billing
    feature_ids:
      - billing.write.partial_refund
    kind: api
    risk: high
    reasons:
      - code: money_path
        note: "refunds.py moves money through the payment provider"
      - code: no_unit_tests
        note: "no test file covers app/billing/refunds.py"
    needs:
      - seed
      - db_read
    depth: standard
    estimate:
      scenarios: 6
      minutes: 4
    confidence: medium
    evidence: "app/billing/refunds.py, commits 9be21c4 and 41d0a77"
```

## Reading the `put_proposal` result

- `local_validation`: `passed`, or `skipped_schema_not_published` when the server has no schema to fetch (the server still validates).
- `proposal`: counts per status and risk, `stale`, and the items with `cell_count` (how many coverage cells each maps to).
- `warnings` are derived, not sent by the server: `confidence_lowered` (Tessa lowered the confidence because a feature or interface id is not in the latest bundle) and `no_cells` (the item maps to no coverage cell, so it cannot become a plan yet; check the feature ids).

## Ticking

Ticking is a team decision. `update_proposal_item` takes `status` `selected`, `declined` or `proposed` (to reset) and an optional `note` of at most 300 characters. `authored` and `covered` are set by Tessa. A 409 means the item belongs to an older proposal or is already authored: read the proposal again with `get_proposal`.

## Production

A target with `tier: production` gets no proposal from this skill: no `issue_prompt`, no `put_proposal`, no `update_proposal_item`. Say so and stop.
