# 1. Requirements

Tessa runs on macOS, Linux and Windows. The commands in these guides use a bash or zsh shell. Windows notes are given where the commands differ.

## Tools

| Tool | Version | What it is for | Install |
|---|---|---|---|
| Git | any recent | cloning the repository | <https://git-scm.com> |
| Docker with Compose v2 | Docker Desktop 4.x or Docker Engine 24+ | Postgres (and optionally Temporal, the API, the worker and the web app as containers) | <https://docs.docker.com/get-docker/> |
| uv | 0.8 or newer | Python 3.13 and the dependencies of `api/` and `worker/` (uv downloads Python for you) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` or `brew install uv` |
| Node.js | 22.12 or newer (24 recommended; on Windows 24.20.0 or newer) | the web app and the Claude Code plugin | <https://nodejs.org> or `brew install node` |
| Temporal CLI | 1.9 or newer | the local Temporal dev server | `brew install temporal`, or the release zip from <https://github.com/temporalio/cli/releases> |
| Claude Code | 2.1 or newer | the repo-aware engineer (see [guide 7](07-claude-code.md)) | `npm install -g @anthropic-ai/claude-code` |

Optional:

| Tool | What it is for |
|---|---|
| Python 3.12 | the Laya grader, which keeps its own virtual environment (see [guide 2](02-database-and-services.md#laya-optional)) |
| `psql` | looking into the database by hand |
| An OpenAI API key | the LLM judge, which grades the steps that code and Laya cannot settle |
| An Anthropic API key | the tie-break judge |

Without model keys Tessa still runs. Steps that need a judge end as **uncertain**, which is never counted as a pass.

## Free ports

Make sure these ports are free on `127.0.0.1`: `5440` (Postgres), `7233` and `8233` (Temporal), `8000` (API), `3000` (web app) and, if you use it, `7006` (Laya).

Postgres listens on 5440, not 5432, so it never collides with a Postgres you already run.

## Hardware

- 8 GB of RAM is enough for the stack with a few browser sessions.
- Laya needs about 2 GB more with the English model, or about 5 GB with all three models, plus about 2.2 GB of disk for the model files.

## Get the code

```bash
git clone https://github.com/Rohitjangid2704/Tessa.git
cd Tessa
```

Every command in these guides starts from this folder, the repository root, unless it says otherwise.

Next: [Database and services](02-database-and-services.md)
