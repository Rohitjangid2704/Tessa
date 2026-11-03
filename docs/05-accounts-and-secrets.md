# 5. Accounts and secrets

## The first login

| | |
|---|---|
| URL | <http://localhost:3000> |
| Email | `admin@tessa.local` |
| Password | `dev-only-admin-password-1` |
| Role | admin |

The API creates this account on its first start, when the `users` table is empty. It takes the email and password from `TESSA_BOOTSTRAP_ADMIN_EMAIL` and `TESSA_BOOTSTRAP_ADMIN_PASSWORD` in `api/.env`. To start with your own admin, change both values **before** the first start of the API. After that the values are no longer read.

The login allows 5 failed attempts per minute for each email and IP address.

## Roles

| Role | Can |
|---|---|
| `viewer` | read everything: targets, runs, findings and reports |
| `member` | everything a viewer can, plus create targets, upload bundles, start runs and work on findings |
| `admin` | everything, plus users, settings, retention and the audit log |

## Add users

From the web app: Settings, Users (as an admin).

From the command line:

```bash
cd api
uv run python scripts/create_user.py --email alice@example.com --name "Alice" --role member
```

The script asks for the password. It never takes it on the command line. Use `--password-stdin` to read it from standard input.

## Personal tokens (for Claude Code and scripts)

In the web app: Settings, Tokens, Create token. The token starts with `ipt_` and is **shown once**. Tessa stores only its hash. A token:

- acts as the user who created it, with that user's role,
- lives at most 90 days (`TESSA_PERSONAL_TOKEN_MAX_DAYS`),
- can be revoked at any time, effective at the next request.

A user can hold at most 10 live tokens. Every write made with a token is recorded in the audit log (Settings, Activity).

## Model keys

| Key | Used for | Where to set it |
|---|---|---|
| `TESSA_OPENAI_API_KEY` | the LLM judge and embeddings | `api/.env` and `worker/.env`, or the web app, Settings |
| `TESSA_ANTHROPIC_API_KEY` | the tie-break judge | same |

Keys you enter in the web app are encrypted in the database with `TESSA_VAULT_KEY`. Tessa never returns a secret through the API.

## The environment of a target

Your app's own secrets (its URLs, test passwords, database connection strings) go into the **Environment** tab of the target. Values are encrypted with `TESSA_VAULT_KEY` and are never shown again. Bundles contain only the variable names.

## Before anyone else can reach your Tessa

Every value that starts with `dev-only-` is public, because it is in this repository. Replace all of them before you expose Tessa on a network:

1. Generate new backend secrets:

   ```bash
   cd api
   uv run python scripts/gen_secrets.py
   ```

   It prints new values for `TESSA_VAULT_KEY`, `TESSA_API_JWT_SECRET`, `TESSA_SIGNING_KEY` and `TESSA_SERVICE_KEY`.

2. Put them in place:

   | Value | Goes into |
   |---|---|
   | `TESSA_VAULT_KEY` | `api/.env` and `worker/.env` |
   | `TESSA_API_JWT_SECRET` | `api/.env`, and as `API_JWT_SECRET` in `client/.env.local` |
   | `TESSA_SIGNING_KEY` | `api/.env` |
   | `TESSA_SERVICE_KEY` | `api/.env`, `worker/.env`, and as `API_SERVICE_KEY` in `client/.env.local` |

3. Generate `AUTH_SECRET` for `client/.env.local` with `openssl rand -base64 33`.
4. Set a strong `POSTGRES_PASSWORD` in `deploy/.env` (before the first start of the Postgres volume) and the same password in `TESSA_DATABASE_URL`.
5. Set your own `TESSA_BOOTSTRAP_ADMIN_EMAIL` and `TESSA_BOOTSTRAP_ADMIN_PASSWORD` before the first API start, or change the admin's password afterwards.
6. Set `TESSA_ENV=prod` in `api/.env` and `worker/.env`. The processes then refuse to start while any `dev-only-` value is left.
7. Set `TESSA_DOCS_ENABLED=false` to hide Swagger, and set `TESSA_PUBLIC_API_URL`, `TESSA_CORS_ORIGINS`, `AUTH_URL` and `NEXT_PUBLIC_API_URL` to your real URLs.
8. Put HTTPS in front of the web app and the API.

Changing `TESSA_VAULT_KEY` makes the secrets stored with the old key unreadable, so set it once before you store any.

Never commit `api/.env`, `worker/.env`, `client/.env.local` or `deploy/.env`. They are in `.gitignore`.

Next: [Using Tessa](06-using-tessa.md)
