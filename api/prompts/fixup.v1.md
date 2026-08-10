You are fixing the Tessa bundle in the folder `tessa/` of this repository. Tessa, a
QA harness that tests the RUNNING app from outside (HTTP, streams, webhooks, a real browser),
validated version {{BUNDLE_VERSION}} of the bundle (schema {{SCHEMA_URL}}, target_token
{{TARGET_TOKEN}}) and scored its completeness {{COMPLETENESS_SCORE}} out of 100; the bar is
{{COMPLETENESS_BAR}}. The open items are listed below.

Fix exactly what is listed and keep everything that is already correct. Read the code; do not
guess. Mark anything you are unsure of with `confidence: low`. Never write a real secret:
placeholders only. Do not modify application code. Keep the existing ids, `schema` and
`target_token` unchanged.

## Open items

{{FIXUP_ITEMS}}

Each item says where Tessa found it (file, JSON pointer into manifest.yaml and line, when
known), what is wrong, and for a completeness check what earns its missing points.

## Format conventions

Tessa reads these files by machine, so follow the shapes below exactly. The JSON Schema at
{{SCHEMA_URL}} is the authority for manifest.yaml; its $defs also define the oracle sidecar, the
flow and the env.template formats.

General
- Paths are relative to `tessa/`, written with `/`, never absolute and never containing `..`.
- YAML files are UTF-8 with 2-space indent, one document, no anchors or aliases. Quote any
  string that contains `: `, ` #`, `?`, `[`, `]`, `{` or `}`, or starts with `*`, `&`, `!`, `%`
  or `@`.
- Ids (interfaces, roles, features, flags, invariants, truth sources, oracles, flows) are slugs:
  letters, digits, `_`, `.`, `:` or `-`, starting with a letter or a digit. Feature ids stay stable
  when you re-run this prompt, for example `smart_log.read.open_maintenance`.
- Placeholders: write `${NAME}`, with NAME made of capital letters, digits and `_` and starting
  with a capital letter (`GRACIE_BASE_URL`), wherever a value is a secret or differs per
  environment: tokens, passwords, DSNs, base URLs, tenant ids. Every `${NAME}` anywhere in the
  bundle must be declared under `environment` and listed in env.template. Use `${...}` for
  nothing else; in shell snippets write `$HOME`, not `${HOME}`.
- References must resolve. A feature's `interfaces` are ids from `interfaces`; its `roles` are
  ids from `roles`, or `all`; its `flag` is an id from `flags`, or `none`. `credential_env`,
  `truth_sources[].connection_env`, `seeds.dsn_env` and every `environment[].interfaces` entry
  name something that is declared. No id or variable name repeats within its list.
- The seed connection (`seeds.dsn_env`) must be a different variable from every truth source
  connection: truth sources only read, seeds write.

manifest.yaml
- Starts with `schema:` and `target_token:` exactly as given above. Top-level keys are schema,
  target_token, app, interfaces, roles, features, data_model, truth_sources, seeds, invariants,
  flags, environment, test_hooks, limitations and cleanup; any other top-level key is an error,
  extra keys inside a section are kept.
- Required: schema, target_token, app, interfaces, roles, features and environment. The lists
  interfaces, roles, features and environment have at least one entry each (an app without
  login declares one role, for example `anonymous`). Leave out an optional section you have
  nothing for.
- Allowed values: app.kind web, api, llm_assistant, worker or cli. Interface kind http, sse,
  websocket, graphql, browser, webhook or cli. Feature kind read, write, flow, auth, admin,
  stream or job. confidence low, medium or high. Invariant check code, probe, oracle or db.
  Truth source kind database or read_endpoint. Environment kind url, dsn, token, password,
  string, number or bool.
- roles: id, level (a whole number; a higher level may do everything a lower one may),
  description, can_see, can_do, credential_env.
- features: the shape of the catalog entry below. Each example has `expected` (what the app must
  do, in words a reviewer or an oracle can check) and either `ask` (the chat input) or `request`
  (method, path, body). `oracle` names a file `oracle/<name>.yaml`. A write feature also gives
  `writes_to`, `confirmation` and `expect_db` ({table, where}) and says in `cleanup` how to
  remove what it wrote.
- truth_sources: id, kind, description, connection_env and, for a database, `dialect` in lower
  case (for example `postgres`).
- test_hooks: `available` is a list of {id, description, endpoint}; `missing` is a list of
  {id, description}.

environment and env.template
- `environment` has one entry per variable: name, kind, secret, required, purpose, interfaces.
  Kinds dsn, token and password are always `secret: true`; set `secret: false` only for harmless
  values such as a URL without credentials, a number or a flag. Never put a user name or password
  inside a URL.
- Where the app is reached: every interface of kind http, sse, graphql, browser or webhook has
  one `kind: url` variable that lists the interface in its `interfaces`. That variable holds the
  origin only (`http://localhost:8080`: no path, no credentials) and the interface address is the
  variable followed by the interface `base_path`; a `base_path` that is already a full URL may
  use `${NAME}` placeholders instead. A `health_endpoint` is a path: with a leading `/` it is
  relative to the origin, otherwise relative to the base path.
- env.template is plain text with one `NAME=value` line per variable, where value is empty or one
  token without spaces: `<describe-it>` for a secret, or a harmless example for a non-secret.
  Put the purpose in a `#` comment line directly above the variable, or after the value as
  `  # purpose`. Blank lines are allowed. Every `environment` entry has exactly one line and no
  other names appear. Example:

  # Base URL of the QA deployment
  GRACIE_BASE_URL=http://localhost:8080

  ADMIN_TOKEN=<admin-api-token>  # API token of the admin role

oracle/
- Each oracle is two files with the same name: `oracle/<name>.sql` (or `.py`) holds the query and
  `oracle/<name>.yaml` describes it. The yaml has:
    name: the file name without extension, as cited in `examples[].oracle`
    feature_ids: ids of the features whose expected result it computes
    language: sql or python
    truth_source: id of the truth source it runs on (optional when there is only one)
    params_schema: a JSON Schema, type object, with a `properties` map (and `required`). A
      property may carry `x-source` to say what supplies it: `clock` (the run's date or time),
      `tenant` (the id of the seeded QA tenant), `role` (the role id the scenario runs as) or
      `literal` (a fixed value, given as `default`)
    sentence_template: a Jinja2 template over `rows` (a list of row objects keyed by column
      name) and `params`, rendering the sentence the app is expected to say
    gold_points: optional list of named values the expected result can quote, each {key,
      expression, template}: `key` in lower case, `expression` a Jinja2 expression over `rows`
      and `params`, `template` an optional Jinja2 template over `value`, `rows` and `params`
- SQL: exactly one SELECT or WITH ... SELECT statement in the dialect of the truth source, with
  parameters written `:name` and each one declared in `params_schema.properties`. No INSERT,
  UPDATE, DELETE, DDL, SELECT INTO, FOR UPDATE, multiple statements, or file and network
  functions.
- Python: the file defines `run(params, connect)` and returns a list of row objects (dicts).
  `connect()` gives a read-only connection to the truth source. No writes, files or network.
- Example oracle/open_maintenance.yaml:

  name: open_maintenance
  feature_ids: [smart_log.read.open_maintenance]
  language: sql
  truth_source: primary_db
  params_schema:
    type: object
    properties:
      tenant_id: {type: string, x-source: tenant}
      today: {type: string, format: date, x-source: clock}
    required: [tenant_id, today]
  sentence_template: "{{{{ rows | length }}}} rooms have open maintenance issues."
  gold_points:
    - key: open_rooms
      expression: rows | length

flows/
- One file `flows/<id>.yaml` per key UI path, with: `id` (the file name without extension),
  `title`, `feature_ids`, `role` (a role id, or `anonymous` before any login) and `steps`.
- Each step has `action`: goto (needs `url`), click, check or hover (need `target`), fill or
  select (need `target` and `value`), press (needs `value`, a key such as Enter) or wait_for
  (waits for `expect`). A `target` is either `role` and `name` together (accessibility role and
  accessible name, for example button and Save) or a `selector` (stable, such as
  `[data-testid=save]`). `expect` is an object describing the state after the step (url,
  visible text, elements); write `{}` or leave it out when nothing is asserted. Secrets in
  `value` are `${NAME}` placeholders.

seeds/
- The reset script restores the QA tenant to the same state on every run and can be run twice.
  `seeds.reset_script` is a file under `seeds/` ending in `.sql`, `.py` or `.sh`. A `.sql` script
  is plain SQL (no psql commands such as `\i`) run in one transaction on the connection named by
  `seeds.dsn_env`; `.py` and `.sh` scripts read the connection values they need from the
  environment variables declared under `environment`.
- `seeds.hash_command` is one command line, run from a copy of the `tessa/` folder, that
  exits 0 and prints a hash of the seeded state as the last line of its output: 8 to 128
  characters from letters, digits, `:`, `_` and `-`, for example `bash seeds/hash.sh`. It only
  reads, and hashes ordered data, never timestamps of the run. `seeds.expected_hash` is the value
  that command should print; give it only if you ran the command, otherwise leave it out and
  Tessa records the first reset.
- `seeds.fixtures` lists any other files under `seeds/` that the reset script needs.

## When you finish

Check the whole bundle once more against the format conventions above. Then finish with a short
list of what you changed and what you still could not determine from the code. The folder will be
zipped and uploaded again; Tessa validates it and compares it with version {{BUNDLE_VERSION}}.
