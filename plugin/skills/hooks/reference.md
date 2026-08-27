# Hooks reference

## What a hook is

A QA-only route of the app that lets Tessa do something it cannot do from outside the process: pin the clock, set a feature flag, flush a cache, reset a counter. The bundle lists what it needs in `test_hooks.missing`; the prompt lists them with their ids and purposes.

## `test_hooks` in `manifest.yaml`

```yaml
test_hooks:
  available:
    - id: pin_clock
      description: Pin the server clock to a fixed instant for the run
      endpoint: POST /__qa/clock
  missing:
    - id: flush_cache
      description: Flush the search cache so results are recomputed
```

- Move an entry from `missing` to `available` only for a hook you added and tested. Keep its `id` unchanged.
- `endpoint` is `METHOD /path`: METHOD is GET, POST, PUT or PATCH; the path starts with one `/` and has no placeholders.
- A hook you did not add stays in `missing`.
- The format of `test_hooks` is part of `schemas/bundle.v1.json`. No other part of the bundle changes.

## Rules for the code of a hook

| Rule | Check |
|---|---|
| Behind a switch that is off by default | a test with the switch off expects 404 |
| Authenticated like the admin routes | a test without credentials with the switch on is refused |
| Small and repeatable | one route, JSON in and out; the same body twice leaves the same state |
| No real side effects | no e-mails, payments, messages or writes outside the QA data |
| No behaviour change with the switch off | the existing tests still pass unchanged |
| Nothing loosened | no existing authentication or permission check is relaxed |

The switch is named after the conventions of the app (for example `QA_HOOKS_ENABLED`). It must never be on in a production configuration, and nothing in the production deploy may turn it on. If the repository has production config files, leave them alone; document the QA setting in `tessa/README.md` only.

## After the upload

`upload_bundle` returns the new version. An upload does not run the health checks; runs use the hooks listed as available. The hooks only exist in QA once the user deploys the branch with the switch on.

`run_health_checks` returns one entry per interface (and `truth:<id>` entries for truth sources) with `status` `unchecked`, `ok`, `failed` or `skipped`, a latency and a message. Only `ok` is healthy. The health checks reach the interfaces and truth sources, never the hook routes: they show that the deployed app answers, and the hook tests of the repository show that the hooks work.

## Production

A target with `tier: production` gets no hooks from this skill: no `issue_prompt`, no code change, no `upload_bundle`, no `run_health_checks`. Say so and stop.
