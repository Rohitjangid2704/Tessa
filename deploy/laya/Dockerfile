FROM python:3.12-slim-bookworm AS builder

ARG PIP_INDEX_URL=https://pypi.org/simple
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m venv /opt/venv

COPY requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install \
    --index-url "${PIP_INDEX_URL}" \
    --extra-index-url "${TORCH_INDEX_URL}" \
    --requirement /tmp/requirements.txt

FROM python:3.12-slim-bookworm AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/models/hf \
    LAYA_HOST=0.0.0.0 \
    LAYA_PORT=7006 \
    LAYA_DEVICE=cpu \
    LAYA_PRELOAD=1 \
    LAYA_MODELS=english,multilingual,typed-decisions

RUN groupadd --system --gid 10001 tessa \
    && useradd --system --uid 10001 --gid tessa --home-dir /tmp --shell /usr/sbin/nologin tessa \
    && mkdir -p /models/hf \
    && chown -R tessa:tessa /models

COPY --from=builder /opt/venv /opt/venv

WORKDIR /tmp
USER tessa

EXPOSE 7006

HEALTHCHECK --interval=15s --timeout=5s --start-period=900s --retries=5 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7006/health', timeout=4)"]

CMD ["laya-serve"]
