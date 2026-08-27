# Discover reference

## The `tessa/` folder

Written at the repository root. Paths inside are relative, use `/`, never start with `/` and never contain `..`.

```
tessa/
  manifest.yaml        required; starts with schema: and target_token: exactly as the prompt gives them
  README.md            the same content in plain language for a QA engineer
  env.template         one NAME=value line per declared variable, a purpose comment for each
  seeds/               reset script (.sql, .py or .sh), hash command target, fixtures
  oracle/              <name>.sql or <name>.py plus <name>.yaml per computable expectation
  flows/               <id>.yaml per key UI path
  openapi.json         when the app exposes a schema; a contract is never proven by an example alone
  scenarios/           authored scenarios, normally written later by /tessa:author, not here
```

Top-level keys of `manifest.yaml`: `schema`, `target_token`, `app`, `interfaces`, `roles`, `features`, `consumes`, `data_model`, `truth_sources`, `seeds`, `invariants`, `flags`, `environment`, `test_hooks`, `limitations`, `cleanup`, and `source`. Required: `schema`, `target_token`, `app`, `interfaces`, `roles`, `features`, `environment`. Any other top-level key is an error.

## The `source` section

```yaml
source:
  commit: 3f2a9c1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c
  branch: feature/rooms
  dirty: false
```

- `commit`: 7 to 40 hex characters, from `git rev-parse HEAD`.
- `branch`: from `git branch --show-current`; leave the key out on a detached head.
- `dirty`: true when `git status --porcelain` prints anything.

It records which code the bundle describes, so a later run can be tied to a commit. If the API reports `source` as an unknown top-level key, the server does not know it yet: remove the section and tell the user.

## Placeholders and secrets

- A value that is secret or differs per environment is written `${NAME}` with NAME in capital letters, digits and `_`, starting with a capital letter.
- Every `${NAME}` anywhere in the bundle is declared under `environment` and has exactly one line in `env.template`. Nothing else uses `${...}`; in shell snippets write `$HOME`.
- `env.template` lines are `NAME=` followed by nothing or one token without spaces: `<describe-it>` for a secret, a harmless example for a non-secret. The purpose goes in a `#` comment above the line or after the value.
- Kinds `dsn`, `token` and `password` are always `secret: true`. A signing secret is a token. Never put a user name or password inside a URL.
- The seed connection (`seeds.dsn_env`) is a different variable from every truth source connection. Truth sources only read; seeds write, and only on the QA database.
- Dotfiles are never uploaded (`.env`, `.git`, `.DS_Store`), so a stray `.env` inside `tessa/` is left out and reported in `zip.excluded`.

## Upload rules enforced by the tool

`validate_bundle` and `upload_bundle` zip the folder in memory: only `tessa/`, in sorted order, with a fixed timestamp. They leave out `.git`, `node_modules`, `__pycache__` and every name that starts with `.`. They refuse symbolic links, a file above 5 MiB, more than 2,000 files and more than 25 MiB in total. When the session has a target and `manifest.yaml` carries a different `target_token`, the call is refused with `target_mismatch` before anything is sent.

## Reading a validation report

`fixup_items` come first and are the to-do list. Each has `kind` (`error`, `check` or `warning`), `location` (file, pointer, line), `message` and `fix_hint`. Fix errors first, then checks (completeness points still missing), then warnings that are cheap to fix. `completeness.score` is compared with `completeness.bar`; `status` says whether it meets the bar. `hooks_missing` lists QA hooks the app lacks; they are reported, not fixed here. `diff_summary` compares with the latest stored version.

## Mapping `.env` to the vault

1. `get_environment` returns the declared variables. Only these can be set.
2. Match `.env` names to declared names exactly. A near match (`DB_URL` against `DATABASE_URL`) is shown to the user as a question, never sent silently.
3. Show names, kind, required, secret and whether a value was found. Never show values or lengths.
4. Sensitive cases to raise before asking:
   - a `dsn` for a truth source (interface ids starting with `truth:`) must be a read-only role;
   - a URL or DSN that points at a production host;
   - a variable the repository's `.env` marks as an example placeholder (empty or `changeme`).
5. One confirmation covers the whole list. `set_environment` then sends exactly the confirmed pairs. Its result lists names set, names cleared and `missing_required_names`.

## Health statuses

`run_health_checks` returns one entry per interface (and `truth:<id>` entries for truth sources) with `status` of `unchecked`, `ok`, `failed` or `skipped`, a latency and a message. Only `ok` is healthy. `failed` messages usually name a refused connection, a bad credential or a wrong base URL; map them back to the `variables` listed on the entry.

## Production

A target with `tier: production` is never written to by this skill: no `issue_prompt`, no `upload_bundle`, no `set_environment`, no `run_health_checks`. Say so and stop.
