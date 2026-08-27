# Connect reference

## The loop in one paragraph

The `tessa` MCP server runs on the engineer's laptop and calls the Tessa REST API with the engineer's personal token. Claude Code holds the repository, the `.env` file and the dev database; Tessa holds bundles, scenarios, runs, verdicts, findings and the encrypted environment store. Values leave the laptop only through the explicit `set_environment` tool call.

## Tools and who may call them

Permission names are `mcp__plugin_tessa_tessa__<tool>`. Read tools are pre-approved by the skills. Write tools always prompt.

| Tool | Kind | Needs role |
|---|---|---|
| `whoami`, `list_targets`, `get_target`, `get_bundle`, `get_environment`, `wait_run`, `get_run`, `get_step`, `run_diff`, `list_findings`, `get_finding`, `get_proposal`, `get_coverage`, `list_scenarios`, `validate_scenario`, `inbox` | read | viewer |
| `validate_bundle` | read (stores nothing) | member |
| `issue_prompt`, `upload_bundle`, `set_environment`, `run_health_checks`, `start_run`, `cancel_run`, `add_explanation`, `move_finding`, `put_proposal`, `update_proposal_item`, `plan_from_proposal` | write | member |

A viewer token can use the viewer tools; `validate_bundle` and every write tool answer 403 for it. A member or admin token can use them all.

## Roles

`viewer` reads. `member` writes (bundles, environment, runs, explanations, finding moves). `admin` also manages users, teams and the audit log. The role is the user's current role, not a property of the token.

## Errors

Every tool failure is a JSON object `{"error": {"code", "status", "message", "requestId", "details"}}`. Quote `requestId` when asking an admin for help.

| code | status | meaning and fix |
|---|---|---|
| `not_configured` | 0 | The plugin has no API URL, a malformed one (it must be the origin, for example `http://localhost:8000`) or no token; the message says which. Run `/plugin`, open the `tessa` plugin and fill in the API URL and the personal token. |
| `token_revoked` | 401 | The token was revoked. Mint a new one in Tessa under Settings, Tokens, then update the plugin configuration. |
| `token_expired` | 401 | The token expired. Same fix. |
| any other 401 | 401 | The token is not valid for this API. Check the API URL and mint a new token. |
| any 403 | 403 | The user's role is too low for this tool. Ask an admin. |
| `network_error` | 0 | The API cannot be reached. Check the URL and that the API is running. |
| any 429 | 429 | Too many calls. The server already waited once; wait and retry. |

## Where things are in the Tessa web app

- Personal tokens: Settings, Tokens. The token starts with `ipt_`, is shown once, has a bounded lifetime (the server default maximum is 90 days) and can be revoked.
- Targets, bundles and the environment: Targets, then the target.
- Saved plans: Catalog, saved plans. The run skill needs a plan id from there, or scenario ids.

## What the loop never does

- It never sends the repository or a `.env` file to Tessa. Only the `tessa/` folder, and only through `upload_bundle`.
- It never writes to a production target.
- It never changes a verdict. An explanation is a proposal; a finding resolves only after a passing re-run.
