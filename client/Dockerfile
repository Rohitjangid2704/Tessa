ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PLUGIN_SOURCE
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_PLUGIN_SOURCE=${NEXT_PUBLIC_PLUGIN_SOURCE} \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 10001 tessa \
    && useradd --system --uid 10001 --gid tessa --home-dir /app --shell /usr/sbin/nologin tessa

WORKDIR /app
COPY --from=builder --chown=tessa:tessa /app/public ./public
COPY --from=builder --chown=tessa:tessa /app/.next/standalone ./
COPY --from=builder --chown=tessa:tessa /app/.next/static ./.next/static

USER tessa

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "server.js"]
