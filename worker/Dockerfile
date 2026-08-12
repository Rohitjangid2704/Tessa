FROM ghcr.io/astral-sh/uv:0.8.17-python3.13-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=automatic \
    UV_PYTHON_PREFERENCE=only-managed \
    UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PROJECT_ENVIRONMENT=/opt/venv

RUN uv python install 3.13

WORKDIR /app/worker

COPY api/ /app/api/
COPY worker/pyproject.toml worker/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY worker/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM mcr.microsoft.com/playwright/python:v1.63.0-noble AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 tessa \
    && useradd --system --uid 10001 --gid tessa --home-dir /app --shell /usr/sbin/nologin tessa \
    && mkdir -p /data \
    && chown tessa:tessa /data

COPY --from=builder /opt/python /opt/python
COPY --from=builder --chown=tessa:tessa /opt/venv /opt/venv
COPY --from=builder --chown=tessa:tessa /app/api /app/api
COPY --from=builder --chown=tessa:tessa /app/worker /app/worker
COPY --chown=tessa:tessa probes/ /app/probes/

WORKDIR /app/worker
USER tessa

CMD ["python", "-m", "tessa_worker.main"]
