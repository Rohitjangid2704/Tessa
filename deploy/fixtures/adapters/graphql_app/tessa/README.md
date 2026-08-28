# GraphQL fixture bundle

Bundle of the Tessa GraphQL fixture (`deploy/fixtures/adapters/graphql_app`), used to exercise the `graphql` adapter.

## What is here

- `manifest.yaml`: one `graphql` interface (`graphql_api`, endpoint `/graphql`), two roles (`staff`, `viewer`), five features, the environment and the test hooks (`GET /health`, `POST /qa/reset`).
- `env.template`: the three variables Tessa needs, placeholders only.
- `scenarios/`: six scenarios, five expected to pass and one that fails by design.

## Scenarios and expected verdicts

| Scenario | Expected |
|---|---|
| `gql-open-issues` | pass |
| `gql-introspection` | pass |
| `gql-staff-creates-issue` | pass (leaves one issue behind; `POST /qa/reset` restores the dataset) |
| `gql-viewer-mutation-refused` | pass (asks for the not authorized error) |
| `gql-anonymous-refused` | pass (asks for status 401) |
| `gql-unknown-field-fails` | fail by design (the schema has no `assignee` field) |

## Values

Set `GRAPHQL_FIXTURE_URL` to the origin of the running fixture, for example `http://127.0.0.1:8521`, and the two tokens to the values the fixture was started with (see the fixture README, development values only).
