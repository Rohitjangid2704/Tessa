import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { channelCapabilities, createChannelPublisher } from "./channel";
import { createTessaApi, systemClock, type Clock } from "./client";
import type { InboxSettings, ServerConfig } from "./config";
import { Inbox } from "./inbox";
import { FileInboxStore, MemoryInboxStore, writeSessionFile, type InboxStore } from "./inbox-store";
import { Redactor } from "./redact";
import { SessionState, SessionTracker } from "./session";
import { TOOLS } from "./tools";
import { executeTool, type ToolContext, type ToolDefinition } from "./tools/define";

export type Logger = (message: string, fields?: Record<string, unknown>) => void;

export type ServerDependencies = {
  config: ServerConfig;
  pluginVersion: string;
  logger: Logger;
  redactor: Redactor;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  generateId?: () => string;
  inbox?: InboxSettings;
};

export type TessaServer = {
  mcp: McpServer;
  session: SessionTracker;
  context: ToolContext;
  inbox: Inbox;
  inboxStore: InboxStore;
};

function tokenPrefixOf(token: string): string {
  return token.startsWith("ipt_") ? token.slice(0, 8) : "unrecognised";
}

export function registerTools(mcp: McpServer, context: ToolContext, tools: ToolDefinition[]): void {
  for (const tool of tools) {
    const hasInput = Object.keys(tool.input).length > 0;
    const config = {
      title: tool.title,
      description: tool.description,
      ...(hasInput ? { inputSchema: tool.input } : {}),
      annotations: {
        title: tool.title,
        readOnlyHint: tool.access === "read",
        destructiveHint: tool.access === "write" && tool.destructive,
        idempotentHint: tool.idempotent,
        openWorldHint: false,
      },
    };
    if (hasInput) {
      mcp.registerTool(tool.name, config, (async (args: unknown) =>
        executeTool(tool, context, args)) as never);
    } else {
      mcp.registerTool(tool.name, config, (async () => executeTool(tool, context, {})) as never);
    }
  }
}

export function createTessaServer(dependencies: ServerDependencies): TessaServer {
  const { config, redactor, logger } = dependencies;
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());
  const clock = dependencies.clock ?? systemClock;
  redactor.addLiteral(config.token);

  const settings: InboxSettings = dependencies.inbox ?? { dataDir: null, watch: [], channel: false, feeds: false };
  const inboxStore: InboxStore =
    settings.dataDir === null
      ? new MemoryInboxStore()
      : new FileInboxStore(join(settings.dataDir, "inbox"), config.claudeSessionId);

  const state = new SessionState();
  const api = createTessaApi({
    baseUrl: config.baseUrl,
    token: config.token,
    configurationProblem: config.problem,
    agentSessionId: () => state.id,
    fetchImpl: dependencies.fetchImpl,
    clock,
    generateId,
  });
  const session = new SessionTracker(state, api, {
    claudeSessionId: config.claudeSessionId,
    cwd: config.cwd,
    pluginVersion: dependencies.pluginVersion,
    log: logger,
    onSession: async (agentSessionId) => {
      if (settings.dataDir === null) {
        return;
      }
      await writeSessionFile(
        settings.dataDir,
        config.claudeSessionId,
        {
          agent_session_id: agentSessionId,
          claude_session_id: config.claudeSessionId,
          target_id: state.targetId ?? null,
        },
        new Date(clock.now()).toISOString(),
      );
    },
    onTarget: (targetId) => {
      if (settings.feeds && config.problem === null) {
        inbox.watch(targetId);
      }
    },
  });
  const context: ToolContext = {
    api,
    session,
    redactor,
    clock,
    generateId,
    tokenPrefix: tokenPrefixOf(config.token),
    inbox: inboxStore,
    log: logger,
  };

  const mcp = new McpServer(
    { name: "tessa", version: dependencies.pluginVersion },
    channelCapabilities(settings.channel),
  );
  registerTools(mcp, context, TOOLS);
  const publisher = settings.channel ? createChannelPublisher(mcp, logger) : null;
  const inbox = new Inbox({
    baseUrl: config.baseUrl,
    token: config.token,
    store: inboxStore,
    redactor,
    clock,
    log: logger,
    fetchImpl: settings.fetchImpl ?? dependencies.fetchImpl,
    random: settings.random,
    idleTimeoutMilliseconds: settings.idleTimeoutMilliseconds,
    onLine: publisher === null ? undefined : (line, text) => publisher.publish(line, text),
  });
  mcp.server.oninitialized = () => {
    if (config.problem !== null) {
      return;
    }
    void session.start();
    if (settings.feeds) {
      for (const targetId of settings.watch) {
        inbox.watch(targetId);
      }
    }
  };
  return { mcp, session, context, inbox, inboxStore };
}
