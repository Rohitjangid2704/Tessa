import { loadEnvConfig } from "@next/env";
import { defineConfig, devices } from "@playwright/test";
import { authStatePath } from "./tests/e2e/helpers/auth-files";
import { DEFAULT_API_URL, DEFAULT_APP_URL, readE2eEnv } from "./tests/e2e/helpers/env";

loadEnvConfig(process.cwd());

const LOOPBACK_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 300_000;
const EXPECT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

function requestedProjects(argumentsList: readonly string[]): string[] {
  const names: string[] = [];
  argumentsList.forEach((argument, index) => {
    if (argument.startsWith("--project=")) {
      names.push(argument.slice("--project=".length));
      return;
    }
    if (argument !== "--project") {
      return;
    }
    for (const following of argumentsList.slice(index + 1)) {
      if (following.startsWith("-")) {
        break;
      }
      names.push(following);
    }
  });
  return names;
}

const e2eEnv = readE2eEnv();
const requested = requestedProjects(process.argv.slice(2));
const runsReal = requested.includes("real");
const runsMocked = requested.length === 0 || requested.includes("mocked");

if (runsReal && !runsMocked) {
  const missing = ["E2E_BASE_URL", "E2E_USER_EMAIL", "E2E_USER_PASSWORD"].filter(
    (key) => !process.env[key],
  );
  if (missing.length > 0) {
    throw new Error(`The real project needs ${missing.join(", ")} (see .env.example)`);
  }
}

const appUrl = new URL(e2eEnv.E2E_BASE_URL ?? DEFAULT_APP_URL);
const apiUrl = new URL(process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL);
const appPort = appUrl.port || "3000";
const apiPort = apiUrl.port || "8000";
const corsOrigins = [appUrl.origin, `http://${LOOPBACK_HOST}:${appPort}`].join(",");

const mockedServers = [
  {
    command: `npm run mock:api -- --port=${apiPort} --cors-origins=${corsOrigins}`,
    url: `http://${LOOPBACK_HOST}:${apiPort}/health`,
    reuseExistingServer: false,
    timeout: SERVER_START_TIMEOUT_MS,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  },
  {
    command: `npm run build && npm run start -- -p ${appPort}`,
    url: `http://${LOOPBACK_HOST}:${appPort}/`,
    reuseExistingServer: false,
    timeout: SERVER_START_TIMEOUT_MS,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      NEXT_PUBLIC_API_URL: apiUrl.origin,
      API_INTERNAL_URL: `http://${LOOPBACK_HOST}:${apiPort}`,
      AUTH_URL: appUrl.origin,
    },
  },
];

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/artifacts",
  timeout: TEST_TIMEOUT_MS,
  expect: { timeout: EXPECT_TIMEOUT_MS },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL: appUrl.origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: runsMocked ? mockedServers : undefined,
  projects: [
    {
      name: "setup-mocked",
      testMatch: "auth.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mocked",
      testMatch: "mocked/**/*.spec.ts",
      dependencies: ["setup-mocked"],
      use: { ...devices["Desktop Chrome"], storageState: authStatePath("mocked") },
    },
    {
      name: "setup-real",
      testMatch: "auth.setup.ts",
      testIgnore: runsReal ? undefined : "**/*",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "real",
      testMatch: "real/**/*.spec.ts",
      testIgnore: runsReal ? undefined : "**/*",
      dependencies: ["setup-real"],
      use: { ...devices["Desktop Chrome"], storageState: authStatePath("real") },
    },
  ],
});
