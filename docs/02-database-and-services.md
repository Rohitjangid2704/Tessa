# 2. Database and services

Tessa needs two services before the API starts: **Postgres** for its data and **Temporal** for its workflows. **Laya**, a small local grading model, is optional.

## Postgres (Docker)

The compose file runs `pgvector/pgvector:pg17` and, on the first start, creates the databases `tessa` (the app), `tessa_test` (the test suites) and `truth_fixture` (a small example database for trying the reference queries).

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d --wait postgres
```

`deploy/.env` holds the compose values:

| Key | Default |
|---|---|
| `POSTGRES_USER` | `tessa` |
| `POSTGRES_PASSWORD` | `dev-only-tessa-postgres-password` |
| `POSTGRES_DB` | `tessa` |
| `POSTGRES_PORT` | `5440` |
| `TEMPORAL_PORT` | `7233` |
| `TEMPORAL_UI_PORT` | `8233` |

The connection string the API and the worker use is:

```
postgresql+asyncpg://tessa:dev-only-tessa-postgres-password@127.0.0.1:5440/tessa
```

If you change the password in `deploy/.env`, change it in `TESSA_DATABASE_URL` in `api/.env` and `worker/.env` too.

Useful commands:

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml stop postgres
docker compose -f deploy/docker-compose.yml start postgres
docker compose -f deploy/docker-compose.yml exec postgres psql -U tessa -d tessa
```

The data lives in the Docker volume `tessa_tessa-postgres`, so it survives a restart. `docker compose down -v` deletes it. The init scripts in `deploy/postgres/init/` run only on an empty volume.

### The example truth database

`truth_fixture` has two tables (`rooms` and `issues`) and two roles with dev-only passwords. Use them to try the reference queries and seeds of Tessa without your own app:

| Environment variable in Tessa | Value |
|---|---|
| `TRUTH_DB_DSN` (read only) | `postgresql://truth_ro:dev-only-truth-ro-password@127.0.0.1:5440/truth_fixture` |
| `SEED_DB_DSN` (read and write) | `postgresql://seed_rw:dev-only-seed-rw-password@127.0.0.1:5440/truth_fixture` |

A ready bundle for it is in `deploy/postgres/truth-fixture/tessa/`.

## Temporal

Every pipeline in Tessa (a run, a seed, a grading pass, a report) is a Temporal workflow. Pick one of the two ways to run Temporal. Both use the same ports, so never run both at once.

**Option A: the Temporal CLI dev server (recommended for local work)**

```bash
mkdir -p deploy/data
temporal server start-dev --port 7233 --ui-port 8233 --db-filename deploy/data/temporal.db
```

Leave it running in its own terminal. The workflow history is kept in `deploy/data/temporal.db`.

**Option B: Temporal in Docker**

```bash
docker compose -f deploy/docker-compose.yml --profile temporal up -d temporal
```

Either way the Temporal UI is at <http://localhost:8233>. Use it to watch the workflows of a run.

Check that it is up:

```bash
temporal operator cluster health
```

## Laya (optional)

Laya answers short typed questions about a text, such as "did the reply refuse?" or "is the tone polite?". It runs on the CPU. Tessa uses it as the cheap grading tier between the code checks and the LLM judge. Without Laya, those checks go to the judge, or end as uncertain when no judge key is set.

Laya needs Python 3.12:

```bash
python3.12 -m venv deploy/laya/.venv
deploy/laya/.venv/bin/pip install -r deploy/laya/requirements.txt
```

Start it on port 7006 with only the English model (about 2 GB of RAM):

```bash
LAYA_HOST=127.0.0.1 LAYA_PORT=7006 LAYA_DEVICE=cpu LAYA_PRELOAD=1 LAYA_MODELS=english \
  deploy/laya/.venv/bin/laya-serve
```

On Windows, `deploy\laya\start.ps1 -Models english` does the same (stop it with `deploy\laya\start.ps1 -Action stop`).

The first start downloads the models from Hugging Face (about 2.2 GB) and can take a few minutes. After that it starts in 10 to 15 seconds. Do not run `laya-serve --help`: it ignores the flag and starts the server.

The API and the worker find Laya through `TESSA_LAYA_URL=http://127.0.0.1:7006`, which is already in their `.env.example`.

## Windows helper

On Windows, `deploy\dev.ps1` starts and stops the native stack for you:

```powershell
deploy\dev.ps1 up        # postgres, temporal, api, worker
deploy\dev.ps1 status
deploy\dev.ps1 down
```

It expects the Temporal CLI at `deploy\bin\temporal.exe` or on PATH.

Next: [Backend](03-backend.md)
