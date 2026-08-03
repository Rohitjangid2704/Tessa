FROM ghcr.io/astral-sh/uv:0.8.17-python3.13-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app/api

COPY api/pyproject.toml api/uv.lock api/README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY api/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.13-slim-bookworm AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN groupadd --system --gid 10001 tessa \
    && useradd --system --uid 10001 --gid tessa --home-dir /app --shell /usr/sbin/nologin tessa \
    && mkdir -p /data \
    && chown tessa:tessa /data

COPY --from=builder --chown=tessa:tessa /opt/venv /opt/venv
COPY --from=builder --chown=tessa:tessa /app/api /app/api
COPY --chown=tessa:tessa schemas/ /app/schemas/
COPY --chown=tessa:tessa probes/ /app/probes/

WORKDIR /app/api
USER tessa

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]

CMD ["uvicorn", "tessa_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
