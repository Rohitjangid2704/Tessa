You are preparing this repository for end-to-end testing by Tessa, a QA harness that
tests the RUNNING app from outside (HTTP, streams, webhooks, a real browser) and computes
expected results from the app's own data. Tessa never sees this repo, so everything it
needs must be in the bundle you create. Read the code; do not guess. Mark anything you are
unsure of with `confidence: low`. Never write a real secret: placeholders only.

Create the folder `tessa/` at the repo root with:

1. manifest.yaml  (schema {{SCHEMA_URL}}, target_token {{TARGET_TOKEN}})
   app: name, one-paragraph summary, kind (web, api, llm_assistant, worker, cli), how to run,
        health endpoint(s), ports, base paths.
   interfaces: every way a client reaches the app: kind (http, sse, websocket, graphql,
        browser, webhook, cli), base path, auth (type, header, how a token is obtained per
        role, and for signed webhook sends the variable that holds the signing secret),
        request and response shapes with one real example each, stream event names, rate
        limits, idempotency rules.
   roles: each role, its level, what it may see and do, and the env var that will hold its
        login or token.
   features: the catalog of testable things (section 2.4 shape): id, area, kind, description,
        interfaces, roles, flag, preconditions, at least one concrete example with the
        expected behaviour, which oracle computes the expectation, invariants that apply,
        cleanup needed after a write.
   consumes: every call THIS app sends to another app (an HTTP API of another service, a
        webhook receiver owned by someone else): the method and path, the shape of what it
        sends, how it authenticates, and the response fields it reads back. Tessa
        compares this section with the other app's own bundle to catch a contract break
        before the consumer sees it. Leave the section out when the app calls no other app.
   data_model: stores, tables or collections, key fields, tenant field, status fields,
        soft-delete rules, timezone handling.
   truth_sources: each database or read endpoint an expected result can be computed from,
        with the env var for a READ-ONLY connection.
   seeds: how to make a QA tenant look the same every run (fixtures, reset script, a
        command that prints a hash of the seeded state).
   invariants: rules that must always hold (auth boundaries, tenant isolation, role
        monotonicity, no internal ids, no claim of a save before confirmation, ...) and how
        each can be checked (code, probe, oracle, db).
   flags: feature flags that change behaviour, their env var, what they affect.
   environment: every variable Tessa needs (URLs, tokens, DSNs) with placeholders.
   test_hooks: which QA hooks exist (health, trace by id, usage) and which are missing
        (pin clock, override flags, flush caches).
   limitations, cleanup: what cannot be undone, what to delete after a run, what costs money.
2. README.md: the same content in plain language for a QA engineer, section by section.
3. env.template: every variable in `environment` with a placeholder and a one-line purpose.
4. seeds/: the fixtures and the reset script (SQL or a script) described in `seeds`.
5. oracle/: one read-only reference query per feature with a computable expectation, with
   parameters (tenant, today, role) and the sentence Tessa should expect from the rows.
6. flows/: the key UI paths as ordered steps (url, action, target by accessibility role or
   stable selector, expected state).
7. openapi.json (or a link) when the app exposes a schema. Tessa can prove a contract
   against an openapi.json; an example alone is never enough to call a contract compatible.

## Format conventions

Tessa reads these files by machine, so follow the shapes below exactly. The JSON Schema at
{{SCHEMA_URL}} is the authority for manifest.yaml; its $defs also define the oracle sidecar, the
flow and the env.template formats.

General
- Paths are relative to `tessa/`, written with `/`, never absolute and never containing `..`.
- YAML files are UTF-8 with 2-space indent, one document, no anchors or aliases. Quote any
  string that contains `: `, ` #`, `?`, `[`, `]`, `{` or `}`, or starts with `*`, `&`, `!`, `%`
  or `@`.
- Ids (interfaces, roles, features, flags, invariants, truth sources, oracles, flows, consumed
  calls) are slugs: letters, digits, `_`, `.`, `:` or `-`, starting with a letter or a digit.
  Feature ids stay stable when you re-run this prompt, for example
  `smart_log.read.open_maintenance`.
- Placeholders: write `${NAME}`, with NAME made of capital letters, digits and `_` and starting
  with a capital letter (`GRACIE_BASE_URL`), wherever a value is a secret or differs per
  environment: tokens, passwords, DSNs, base URLs, tenant ids. Every `${NAME}` anywhere in the
  bundle must be declared under `environment` and listed in env.template. Use `${...}` for
  nothing else; in shell snippets write `$HOME`, not `${HOME}`.
- References must resolve. A feature's `interfaces` are ids from `interfaces`; its `roles` are
  ids from `roles`, or `all`; its `flag` is an id from `flags`, or `none`. `credential_env`,
  `auth.secret_env`, `truth_sources[].connection_env`, `seeds.dsn_env` and every
  `environment[].interfaces` entry name something that is declared. No id or variable name
  repeats within its list.
- The seed connection (`seeds.dsn_env`) must be a different variable from every truth source
  connection: truth sources only read, seeds write.

manifest.yaml
- Starts with `schema:` and `target_token:` exactly as given above. Top-level keys are schema,
  target_token, app, interfaces, roles, features, consumes, data_model, truth_sources, seeds,
  invariants, flags, environment, test_hooks, limitations and cleanup; any other top-level key
  is an error, extra keys inside a section are kept.
- Required: schema, target_token, app, interfaces, roles, features and environment. The lists
  interfaces, roles, features and environment have at least one entry each (an app without
  login declares one role, for example `anonymous`). Leave out an optional section you have
  nothing for.
- Allowed values: app.kind web, api, llm_assistant, worker or cli. Interface kind http, sse,
  websocket, graphql, browser, webhook or cli. Feature kind read, write, flow, auth, admin,
  stream or job. confidence low, medium or high. Invariant check code, probe, oracle or db.
  Truth source kind database or read_endpoint. Environment kind url, dsn, token, password,
  string, number or bool.
- interfaces[].auth: `type` is the scheme the app expects, for example none, bearer, api_key,
  basic, cookie, oauth2 or hmac_sha256. `header` is the header that carries the credential. Use
  `hmac_sha256` when the app verifies a signed POST (a webhook receiver): `header` is the header
  that carries the hex signature, for example X-Signature-256, and `secret_env` is the name of
  the environment variable that holds the shared signing secret; declare that variable under
  `environment` with `secret: true` and give it a line in env.template. `secret_env` is required
  for hmac_sha256 and ignored by every other scheme.
- roles: id, level (a whole number; a higher level may do everything a lower one may),
  description, can_see, can_do, credential_env.
- features: the shape of the catalog entry below. Each example has `expected` (what the app must
  do, in words a reviewer or an oracle can check) and either `ask` (the chat input) or `request`
  (method, path, body). `oracle` names a file `oracle/<name>.yaml`. A write feature also gives
  `writes_to`, `confirmation` and `expect_db` ({table, where}) and says in `cleanup` how to
  remove what it wrote.
- job features: for background and data-pipeline work (ingest, parse, chunk, index, export,
  scheduled jobs, queue consumers) use kind `job`. Say in `description` what starts the job (an
  upload, a queue message, a schedule, an HTTP call), what it produces and where that can be
  observed (an index, a table, a status endpoint). Put in `preconditions` the fixture that
  feeds it. Give one example whose `expected` states the observable end state after the job has
  finished, and which roles may see the result (a document ingested for one role must stay
  invisible to the others). Say in `cleanup` how to remove what a run ingested; a record the
  job creates should carry a value Tessa can set per run, such as the title or an external
  id, so a run can find and delete exactly its own records. List under `test_hooks.missing`
  anything needed to wait for the job (a status endpoint, a flush hook).
- consumes: one entry per distinct call this app sends to another app, taken from the code that
  makes the call (an HTTP client, an SDK wrapper, a webhook sender). Each entry has:
    id: a slug, unique within the section, for example `calendar_event_push`
    provider_hint: the name or slug of the app that receives the call, when the code or its
      configuration says so (for example the service name in its base URL variable); leave it
      out when unknown
    method: the HTTP method, for example POST
    path: the path the call is sent to, below the base path of the other app's interface, with
      `{name}` for every path parameter (write `/rooms/{room_id}/events`, not a concrete id), no
      query string and no host; start it with `/`
    auth_scheme: how the call authenticates, one of none, bearer, api_key, basic, oauth2,
      cookie or hmac_sha256; leave it out when unknown
    request: an object, always present. Either a JSON Schema of the request body (with `type`,
      `properties` and `required`, and `enum` for closed value sets) or one real example body
      taken from the code. Prefer the JSON Schema when the code builds the body from a typed
      model. Use `{}` for a call that sends no body. Never put a real secret or personal data
      in an example: use placeholders or obviously fake values
    reads: a list of the response fields this app reads, as dotted paths from the response body
      root: `data.id`, `data.status`, `items[].name` for a field of every array element. List
      every field the code reads, and only those; use `[]` only when the code reads nothing from
      the response. Tessa cannot call the call compatible without a request shape and the
      fields it reads, so an entry without them is reported as uncertain, never as a pass
  Write one entry per method and path, not one per call site. Do not list calls to the app's own
  interfaces, to databases or to third-party SaaS APIs that have no Tessa bundle. Set
  `confidence: low` on an entry you inferred rather than read from the code.
  Example:

  consumes:
    - id: calendar_event_push
      provider_hint: hotel-ops
      method: POST
      path: /calendar/events
      auth_scheme: bearer
      request:
        type: object
        required: [title, starts_at]
        properties:
          title: {type: string}
          starts_at: {type: string}
          status: {type: string, enum: [tentative, confirmed]}
      reads: [data.id, data.status]
- truth_sources: id, kind, description, connection_env and, for a database, `dialect` in lower
  case (for example `postgres`).
- test_hooks: `available` is a list of {id, description, endpoint}; `missing` is a list of
  {id, description}.

environment and env.template
- `environment` has one entry per variable: name, kind, secret, required, purpose, interfaces.
  Kinds dsn, token and password are always `secret: true`; set `secret: false` only for harmless
  values such as a URL without credentials, a number or a flag. A signing secret is a token:
  `kind: token`, `secret: true`. Never put a user name or password inside a URL.
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

## App-specific instructions

{{APP_KIND_HINTS}}

## When you finish

Do not modify application code. If the app lacks the QA hooks above, list them under
test_hooks.missing; a separate prompt will ask for them. Finish with a short checklist of
what you could not determine from the code, including every `consumes` entry whose request
shape or response fields you could not read from the code.
