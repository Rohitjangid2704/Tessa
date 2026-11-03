# Contributing to Tessa

Thanks for helping. Bug reports, fixes, docs and new adapters are all welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce it, what you expected and what happened. Include your OS and the versions of Docker, uv and Node.
- For a larger change (a new adapter, a new workflow, a change to a published schema), open an issue first so we can agree on the shape.

## Set up

Follow the [installation guides](docs/README.md). For work on the web app alone, `cd client && npm run dev:mock` runs it against the mock API, with no backend needed.

## Checks to run before a pull request

Backend:

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest
cd worker && uv run ruff check . && uv run ruff format --check . && uv run pytest
```

The integration tests need the compose Postgres and Temporal. Without them, add `-m "not integration"`.

Web app:

```bash
cd client && npm run ci
```

Plugin:

```bash
cd plugin/server && npm ci && npm test
```

`npm test` also runs `claude plugin validate`, so it needs the Claude Code CLI on your PATH. `npx vitest run` runs the unit tests alone.

## House rules

- **No comments in code** unless they explain something the code cannot. Prefer clear names.
- **Settings are strict.** When you add, rename or remove a settings key, update `api/.env.example`, `api/.env.test`, `worker/.env.example`, the `environment:` block of `deploy/docker-compose.yml` (if the key is not a secret) and the Kubernetes ConfigMaps in `deploy/k8s/base/foundation/config/` (or `deploy/k8s/base/secret.example.yaml` for a secret).
- **API changes** must keep `api/openapi.json` in step: `cd api && uv run python scripts/export_openapi.py`, then `cd client && npm run api:types`.
- **Schema changes** must keep `schemas/` in step: `cd api && uv run python scripts/export_schemas.py`.
- **Database changes** need an Alembic migration in `api/alembic/versions/`.
- **Models are called only at named activities,** with an input schema, an output schema, a budget and a timeout. Control flow stays in Temporal workflows.
- **Never commit secrets** or real `.env` files. Test fixtures use obviously fake values.
- Line endings are LF (see `.gitattributes`).

## Pull requests

- Keep a pull request to one topic, with a short description of what it changes and why.
- Add or update the tests for the behaviour you change.
- By submitting a pull request, you agree that your contribution is licensed under the [MIT License](LICENSE).
