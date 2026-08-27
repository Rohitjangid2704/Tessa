import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import plugin from "../../.claude-plugin/plugin.json";
import { readConfig, readInboxSettings } from "./config";
import { pruneStaleFiles } from "./inbox-store";
import { Redactor } from "./redact";
import { runtimeAdvisory } from "./runtime";
import { createTessaServer, type Logger } from "./server";

const STALE_FILE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const FORCED_EXIT_MILLISECONDS = 10_000;

function createLogger(redactor: Redactor): Logger {
  return (message, fields) => {
    const line = redactor.value({ time: new Date().toISOString(), message, ...fields });
    process.stderr.write(`${JSON.stringify(line)}\n`);
  };
}

async function main(): Promise<void> {
  const redactor = new Redactor();
  const logger = createLogger(redactor);
  const config = readConfig(process.env, process.cwd(), randomUUID);
  const inboxSettings = readInboxSettings(process.env);
  const { mcp, session, inbox } = createTessaServer({
    config,
    pluginVersion: plugin.version,
    logger,
    redactor,
    inbox: inboxSettings,
  });
  if (inboxSettings.dataDir !== null) {
    void pruneStaleFiles(inboxSettings.dataDir, STALE_FILE_MILLISECONDS, Date.now()).catch(() => undefined);
  }

  if (config.problem !== null) {
    logger("tessa is not configured", { problem: config.problem });
  }
  const advisory = runtimeAdvisory(process.version, process.platform);
  if (advisory !== null) {
    logger("node runtime has a known crash", { advisory });
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    process.exitCode = 0;
    setTimeout(() => process.exit(), FORCED_EXIT_MILLISECONDS).unref();
    await inbox.stop();
    await session.end();
    await mcp.close().catch(() => undefined);
    process.stdin.destroy();
  };

  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await mcp.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ message: "tessa server failed to start", error: String(error) })}\n`);
  process.exit(1);
});
