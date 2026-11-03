# 3. Backend: the API and the worker

The backend has two Python processes that share one database and one data folder:

- **The API** (`api/`, package `tessa_api`): FastAPI. It serves the web app and the Claude Code plugin, stores targets, bundles, runs and findings, and starts workflows in Temporal.
- **The worker** (`worker/`, package `tessa_worker`): a Temporal worker. It runs the workflows: it calls your app over HTTP, SSE, WebSocket and GraphQL, drives Chromium with Playwright, grades the steps and posts the events back to the API.

Postgres and Temporal must be running first (see [guide 2](02-database-and-services.md)).

## The API

```bash
cd api
uv sync
cp .env.example .env
uv run alembic upgrade head
uv run uvicorn tessa_api.main:app --reload --port 8000
```

- `uv sync` installs Python 3.13 and the dependencies into `api/.venv`.
- `alembic upgrade head` creates the tables. Run it again after every `git pull`.
- On its first start the API creates the admin account `admin@tessa.local` with the password `dev-only-admin-password-1`.

Check it:

| URL | What you get |
|---|---|
| <http://localhost:8000/health> | `200` when the API is alive |
| <http://localhost:8000/api/v1/docs> | Swagger UI with every endpoint |
| <http://localhost:8000/api/v1/openapi.json> | the OpenAPI document |

The API boots even when Temporal is down. Routes that need Temporal answer `503 dependency_unavailable` until it is back.

## The worker

In a second terminal:

```bash
cd worker
uv sync
cp .env.example .env
uv run playwright install chromium
uv run python -m tessa_worker.main
```

- `playwright install chromium` downloads the browser once. Without it the worker still runs, and browser scenarios are skipped with the reason `adapter_unsupported`.
- The worker finds the API through `TESSA_API_INTERNAL_URL` (`http://127.0.0.1:8000`) and Temporal through `TESSA_TEMPORAL_ADDRESS` (`127.0.0.1:7233`).
- `TESSA_DATA_DIR=../api/data` makes the worker share the API's data folder (bundles, screenshots, recordings, reports).

## Check the whole backend with a hello run

The hello run is a tiny workflow that goes through the API, Temporal, the worker and back:

```bash
cd api
TOKEN=$(uv run python scripts/dev_token.py)
RUN_ID=$(curl -s -X POST http://localhost:8000/api/v1/system/hello-runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: hello-$(date +%s)" \
  -H "Content-Type: application/json" \
  -d '{"ticks":5}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["run_id"])')
uv run python scripts/ws_tail.py "$RUN_ID"
```

You should see `run.created`, `run.status_changed`, five `hello.tick` events and `run.finished`. `dev_token.py` prints a 5-minute API token for the admin account.

## Settings

Settings are strict on purpose:

- Every key lives in `api/.env` and `worker/.env`. The full list with the defaults is in `api/.env.example` and `worker/.env.example`.
- An unknown `TESSA_*` key, in the file or exported in your shell, stops the process at startup. If the API refuses to start, run `env | grep TESSA_` and unset what you find.
- `TESSA_ENV=prod` refuses any value that still starts with `dev-only-`.

The keys you are most likely to change:

| Key | In | What it does |
|---|---|---|
| `TESSA_DATABASE_URL` | api, worker | the Postgres connection |
| `TESSA_TEMPORAL_ADDRESS` | api, worker | the Temporal server |
| `TESSA_CORS_ORIGINS` | api | the origins of the web app |
| `TESSA_PUBLIC_API_URL` | api | the URL people and the plugin use to reach the API |
| `TESSA_OPENAI_API_KEY` | api, worker | the LLM judge (you can also set it in the web app, Settings) |
| `TESSA_ANTHROPIC_API_KEY` | api, worker | the tie-break judge |
| `TESSA_RUN_DEFAULT_MAX_USD`, `TESSA_RUN_DEFAULT_MAX_MINUTES` | api | the default hard budget of a run |
| `TESSA_PRODUCTION_URL_PATTERNS` | api | a regex for production URLs, which Tessa refuses to write to |
| `TESSA_SLACK_WEBHOOK_URL` | api, worker | Slack notifications |
| `TESSA_STUB_MODELS` | api, worker | `true` replaces the model calls with stubs (tests only) |

Some keys must hold the same value in several files. The defaults already match:

| Value | Must match in |
|---|---|
| `TESSA_SERVICE_KEY` | `api/.env`, `worker/.env`, and `API_SERVICE_KEY` in `client/.env.local` |
| `TESSA_VAULT_KEY` | `api/.env`, `worker/.env` |
| `TESSA_API_JWT_SECRET`, `_ISSUER`, `_AUDIENCE` | `api/.env`, and `API_JWT_SECRET`, `_ISSUER`, `_AUDIENCE` in `client/.env.local` |

## Run everything in Docker instead

The compose file can also build and run the API, the worker and the web app as containers. Create the `.env` files first (as above), then:

```bash
docker compose -f deploy/docker-compose.yml --profile temporal --profile apps --profile web build
docker compose -f deploy/docker-compose.yml --profile temporal --profile apps up -d
docker compose -f deploy/docker-compose.yml --profile apps run --rm api alembic upgrade head
docker compose -f deploy/docker-compose.yml --profile web up -d web
```

The containers override only the hostnames (`postgres`, `temporal`, `api`), use the `tessa-data` volume for files and run Chromium headless. Do not run a native API on port 8000 at the same time.

## Tests

```bash
cd api && uv run pytest -m "not integration"
cd worker && uv run pytest -m "not integration"
```

The integration tests need Postgres and Temporal and read their settings from `api/.env.test`.

## Kubernetes

Kustomize manifests are in `deploy/k8s/` (base plus `dev`, `staging` and `prod` overlays). They have not yet been applied to a real cluster, so treat them as a starting point.

Next: [Frontend](04-frontend.md)
