import { loadEnvConfig } from "@next/env";
import { MOCK_DEFAULT_PORT } from "../config";
import { startMockServer } from "./http";

const MAX_PORT = 65_535;

function parsePort(raw: string | undefined): number | null {
  const port = Number(raw);
  return raw !== undefined && Number.isInteger(port) && port >= 0 && port <= MAX_PORT ? port : null;
}

function readPortFromArguments(argumentsList: readonly string[]): number | null {
  const inline = argumentsList.find((argument) => argument.startsWith("--port="));
  if (inline !== undefined) {
    return parsePort(inline.slice("--port=".length));
  }
  const flagIndex = argumentsList.indexOf("--port");
  return flagIndex >= 0 ? parsePort(argumentsList[flagIndex + 1]) : null;
}

function readCorsOriginsFromArguments(argumentsList: readonly string[]): string[] | undefined {
  const inline = argumentsList.find((argument) => argument.startsWith("--cors-origins="));
  if (inline === undefined) {
    return undefined;
  }
  return inline
    .slice("--cors-origins=".length)
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
}

function readSimulationSpeedFromArguments(argumentsList: readonly string[]): number | undefined {
  const inline = argumentsList.find((argument) => argument.startsWith("--sim-speed="));
  if (inline === undefined) {
    return undefined;
  }
  const speed = Number(inline.slice("--sim-speed=".length));
  return Number.isFinite(speed) && speed > 0 ? speed : undefined;
}

function readPortFromApiUrl(apiUrl: string | undefined): number | null {
  if (apiUrl === undefined || apiUrl === "") {
    return null;
  }
  const { port } = new URL(apiUrl);
  return port === "" ? null : Number(port);
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());
  const argumentsList = process.argv.slice(2);
  const port =
    readPortFromArguments(argumentsList) ??
    readPortFromApiUrl(process.env.NEXT_PUBLIC_API_URL) ??
    MOCK_DEFAULT_PORT;
  const corsOrigins = readCorsOriginsFromArguments(argumentsList);
  const running = await startMockServer({
    port,
    config: corsOrigins === undefined ? undefined : { corsOrigins },
    simulationSpeed: readSimulationSpeedFromArguments(argumentsList),
  });
  console.log(`mock api listening on ${running.baseUrl} (ws ${running.wsBaseUrl})`);

  const shutdown = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
