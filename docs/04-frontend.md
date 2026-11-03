# 4. Frontend: the web app

The web app in `client/` is a Next.js 16 app. You use it to sign in, add targets, upload bundles, pick what to test, watch runs live and work through findings.

## Install and start

The API must be running on port 8000 (see [guide 3](03-backend.md)).

```bash
cd client
npm install
cp .env.example .env.local
npm run check:env
npm run dev
```

Open <http://localhost:3000> and sign in with `admin@tessa.local` / `dev-only-admin-password-1`.

Always open the app on `http://localhost:3000`, not on `127.0.0.1:3000` or another port. That origin is `AUTH_URL` and is in the API's CORS list. `npm run dev` listens on `127.0.0.1` only.

## Try the app without the backend

The repository ships a mock API with data for every screen. It is handy for a quick look or for working on the UI:

```bash
cd client
npm install
cp .env.example .env.local
npm run dev:mock
```

This starts the mock API on port 8000 and the web app on port 3000. Do not run it while the real API is on port 8000.

## Settings (`client/.env.local`)

| Key | Default | What it is |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | the API as the browser sees it |
| `API_INTERNAL_URL` | `http://127.0.0.1:8000` | the API as the Next.js server sees it |
| `AUTH_URL` | `http://localhost:3000` | the public URL of the web app |
| `AUTH_SECRET` | `dev-only-...` | encrypts the session cookie |
| `AUTH_SESSION_MAX_AGE_SECONDS` | `28800` | session length (8 hours) |
| `API_JWT_SECRET`, `API_JWT_ISSUER`, `API_JWT_AUDIENCE` | match `api/.env` | sign the short-lived API tokens of the web app |
| `API_JWT_TTL_SECONDS` | `300` | lifetime of those tokens |
| `API_SERVICE_KEY` | matches `TESSA_SERVICE_KEY` | server-to-server calls to the API |
| `NEXT_PUBLIC_PLUGIN_SOURCE` | empty | the marketplace source shown in the Connect panel, for example `https://github.com/Rohitjangid2704/Tessa` |
| `CSP_ENFORCE` | `false` | `true` enforces the Content Security Policy, `false` only reports it |
| `E2E_*` | | settings of the Playwright tests against the real stack |

`npm run check:env` tells you when a key is missing or malformed.

## Production build

```bash
npm run build
npm run start
```

Or as a container: `docker compose -f deploy/docker-compose.yml --profile web up -d --build web`. The image takes `NEXT_PUBLIC_API_URL` at build time, because Next.js bakes `NEXT_PUBLIC_*` values into the bundle.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | development server on 127.0.0.1:3000 |
| `npm run dev:mock` | the mock API and the development server together |
| `npm run mock:api` | the mock API only |
| `npm run build`, `npm run start` | production build and server |
| `npm run lint`, `npm run typecheck`, `npm run format:check` | checks |
| `npm run test` | Vitest unit tests |
| `npm run test:e2e` | Playwright tests (`--project=real` needs the whole stack) |
| `npm run api:types` | regenerate the API types from `api/openapi.json` |
| `npm run ci` | every check, then a build |

Next: [Accounts and secrets](05-accounts-and-secrets.md)
