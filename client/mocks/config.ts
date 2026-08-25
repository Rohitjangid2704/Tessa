export const MOCK_DEFAULT_PORT = 8000;

export const CORS_ALLOWED_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];
export const CORS_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "Last-Event-ID",
  "X-Request-ID",
];
export const CORS_EXPOSED_HEADERS = [
  "X-Request-ID",
  "Idempotency-Replayed",
  "Retry-After",
  "Content-Disposition",
];
export const CORS_SAFELISTED_REQUEST_HEADERS = [
  "Accept",
  "Accept-Language",
  "Content-Language",
  "Content-Type",
];
export const CORS_MAX_AGE_SECONDS = 600;

export const WS_RUN_PATH_PREFIX = "/ws/v1/runs/";

export const REQUEST_ID_HEADER = "X-Request-ID";
export const AGENT_SESSION_HEADER = "X-Agent-Session";
export const SERVICE_KEY_HEADER = "X-Service-Key";
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_SECONDS = 60;
export const VERIFY_FAULT_RETRY_AFTER_SECONDS = 30;

export interface MockConfig {
  apiJwtSecret: string;
  apiJwtIssuer: string;
  apiJwtAudience: string;
  serviceKey: string;
  wsTicketSigningKey: string;
  wsTicketTtlSeconds: number;
  heartbeatIntervalMs: number;
  streamMaxAgeMs: number;
  replayMaxEvents: number;
  maxConnectionsPerUser: number;
  helloStartDelayMs: number;
  helloFinishDelayMs: number;
  corsOrigins: string[];
}

export const DEFAULT_MOCK_CONFIG: MockConfig = {
  apiJwtSecret: "dev-only-api-jwt-secret-0123456789abcdef",
  apiJwtIssuer: "tessa-web",
  apiJwtAudience: "tessa-api",
  serviceKey: "dev-only-service-key-0123456789abcdefgh",
  wsTicketSigningKey: "dev-only-ws-ticket-signing-key-0123456789",
  wsTicketTtlSeconds: 30,
  heartbeatIntervalMs: 15_000,
  streamMaxAgeMs: 900_000,
  replayMaxEvents: 5000,
  maxConnectionsPerUser: 20,
  helloStartDelayMs: 50,
  helloFinishDelayMs: 50,
  corsOrigins: CORS_ALLOWED_ORIGINS,
};

function stringFromEnv(env: Record<string, string | undefined>, key: string, fallback: string) {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
}

export function resolveMockConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<MockConfig> = {},
): MockConfig {
  return {
    ...DEFAULT_MOCK_CONFIG,
    apiJwtSecret: stringFromEnv(env, "API_JWT_SECRET", DEFAULT_MOCK_CONFIG.apiJwtSecret),
    apiJwtIssuer: stringFromEnv(env, "API_JWT_ISSUER", DEFAULT_MOCK_CONFIG.apiJwtIssuer),
    apiJwtAudience: stringFromEnv(env, "API_JWT_AUDIENCE", DEFAULT_MOCK_CONFIG.apiJwtAudience),
    serviceKey: stringFromEnv(env, "API_SERVICE_KEY", DEFAULT_MOCK_CONFIG.serviceKey),
    ...overrides,
  };
}
