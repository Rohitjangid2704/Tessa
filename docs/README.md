# Tessa documentation

These guides take you from a fresh clone to a working Tessa that tests your own app, driven from Claude Code.

| # | Guide | Read it when |
|---|---|---|
| 1 | [Requirements](01-requirements.md) | before you install anything |
| 2 | [Database and services](02-database-and-services.md) | you set up Postgres, Temporal and the optional Laya grader |
| 3 | [Backend](03-backend.md) | you install and start the API and the worker |
| 4 | [Frontend](04-frontend.md) | you install and start the web app |
| 5 | [Accounts and secrets](05-accounts-and-secrets.md) | you sign in, add users, add model keys or expose Tessa to other people |
| 6 | [Using Tessa](06-using-tessa.md) | you test your first app |
| 7 | [Using Tessa with Claude Code](07-claude-code.md) | you connect Claude Code through the `tessa` plugin |
| 8 | [How it works](08-how-it-works.md) | you want the architecture and the design rules |
| 9 | [Troubleshooting](09-troubleshooting.md) | something does not start or a run looks wrong |

## The whole stack at a glance

| Service | Address | Started by |
|---|---|---|
| Postgres 17 + pgvector | `127.0.0.1:5440` | Docker Compose |
| Temporal (gRPC) | `127.0.0.1:7233` | `temporal server start-dev` or Docker Compose |
| Temporal UI | <http://localhost:8233> | same as above |
| API | <http://localhost:8000> (Swagger at `/api/v1/docs`) | `uvicorn` in `api/` |
| Worker | no port (metrics on 9100 when enabled) | `python -m tessa_worker.main` in `worker/` |
| Web app | <http://localhost:3000> | `npm run dev` in `client/` |
| Laya (optional) | `127.0.0.1:7006` | `laya-serve` |

Start order: Postgres, then Temporal, then the API, then the worker, then the web app. The worker keeps retrying until Temporal is up, so the order between those two is not strict.

## Default local login

| Email | Password |
|---|---|
| `admin@tessa.local` | `dev-only-admin-password-1` |

This account is created on the first start of the API, when the database has no users yet. Every value that starts with `dev-only-` is for a local machine only. See [Accounts and secrets](05-accounts-and-secrets.md) before anyone else can reach your Tessa.
