# 9. Troubleshooting

## Startup

| Symptom | Cause and fix |
|---|---|
| The API or the worker exits at once with a settings error about an unknown key | A `TESSA_*` variable is exported in your shell, or there is a typo in `.env`. Run `env \| grep TESSA_`, unset what you find and compare `.env` with `.env.example` |
| A settings error about a missing key | `.env` is older than `.env.example`. Copy the missing keys over |
| `TESSA_ENV=prod` refuses to start | a value still starts with `dev-only-`. See [Accounts and secrets](05-accounts-and-secrets.md#before-anyone-else-can-reach-your-tessa) |
| `connection refused` on port 5440 | Postgres is not running: `docker compose -f deploy/docker-compose.yml up -d --wait postgres` |
| `relation ... does not exist` | the migrations did not run: `cd api && uv run alembic upgrade head` |
| `extension "vector" is not available` | the database was not created by the compose image. Use the `pgvector/pgvector:pg17` container from `deploy/docker-compose.yml` |
| `503 dependency_unavailable` with code `temporal` | Temporal is down. Start it (see [guide 2](02-database-and-services.md#temporal)). The API recovers without a restart |
| The port is already in use | another process holds 8000, 3000, 5440 or 7233. Stop it, or change the port in the matching `.env` (and in every URL that points to it) |

## The web app

| Symptom | Cause and fix |
|---|---|
| The sign-in loops, or there are CORS errors in the console | open the app on `http://localhost:3000` exactly, the value of `AUTH_URL`, and keep `TESSA_CORS_ORIGINS` in `api/.env` in step with it |
| `401` on every API call after sign-in | `API_JWT_SECRET`, `API_JWT_ISSUER` or `API_JWT_AUDIENCE` in `client/.env.local` differ from the `TESSA_API_JWT_*` values in `api/.env` |
| "Too many attempts" at sign-in | 5 failed logins per minute per email and IP. Wait a minute |
| `npm run check:env` fails | a key in `client/.env.local` is missing or malformed. Compare it with `.env.example` |

## Runs

| Symptom | Cause and fix |
|---|---|
| A run stays queued | the worker is not running, or it uses another task queue. `TESSA_TEMPORAL_TASK_QUEUE` must match in `api/.env` and `worker/.env`. Check the workflow in the Temporal UI at <http://localhost:8233> |
| Browser steps are skipped with `adapter_unsupported` | Chromium is missing: `cd worker && uv run playwright install chromium` |
| Many steps end as uncertain | no judge key is set (`TESSA_OPENAI_API_KEY`) and Laya is down. Uncertain is never a pass; add a key or start Laya |
| Run events go missing after an API restart | the worker retries an event five times (about 25 seconds), then moves on. Keep API restarts short during a run |
| A run stops with "over budget" | the run hit its dollar or minute budget. Raise it in the plan, or change `TESSA_RUN_DEFAULT_MAX_USD` and `TESSA_RUN_DEFAULT_MAX_MINUTES` |
| The worker cannot reach the API | `TESSA_API_INTERNAL_URL` in `worker/.env` must point to the API (`http://127.0.0.1:8000` natively, `http://api:8000` in compose), and `TESSA_SERVICE_KEY` must match the API's |
| Bundle files or screenshots are not found | the API and the worker must share one data folder: `TESSA_DATA_DIR=./data` in `api/.env` and `../api/data` in `worker/.env` |

## Laya

| Symptom | Cause and fix |
|---|---|
| The first start takes minutes | it is downloading about 2.2 GB of models from Hugging Face. Later starts take 10 to 15 seconds |
| Out of memory | start only the English model: `LAYA_MODELS=english` |
| `hello.laya` shows `ok: false` | Laya is not running on `TESSA_LAYA_URL`. Runs still complete without it |

## Reset everything

This deletes all Tessa data:

```bash
docker compose -f deploy/docker-compose.yml down -v
rm -rf deploy/data api/data
docker compose -f deploy/docker-compose.yml up -d --wait postgres
cd api && uv run alembic upgrade head
```

## Still stuck?

Open an issue with the command you ran, the full error and your OS, Docker, uv and Node versions. Remove any secret from logs before you paste them.
