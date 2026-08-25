import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createMswApp } from "@mswjs/http-middleware";
import { MOCK_DEFAULT_PORT, type MockConfig } from "../config";
import { createFallbackHandlers } from "../handlers/fallback";
import { handlers } from "../handlers";
import { mockState } from "../state";
import { withCors } from "./cors";
import { FeedHub } from "./sse";
import { RunSocketHub } from "./ws";

const LOOPBACK_HOST = "127.0.0.1";

export interface MockServerOptions {
  port?: number;
  host?: string;
  config?: Partial<MockConfig>;
  simulationSpeed?: number;
}

export interface RunningMockServer {
  server: Server;
  hub: RunSocketHub;
  feeds: FeedHub;
  port: number;
  baseUrl: string;
  wsBaseUrl: string;
  close: () => Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startMockServer(options: MockServerOptions = {}): Promise<RunningMockServer> {
  if (options.config !== undefined) {
    mockState.configure(options.config);
  }
  if (options.simulationSpeed !== undefined) {
    mockState.stageTwo.clock.defaultSpeed = options.simulationSpeed;
    mockState.stageTwo.clock.setSpeed(options.simulationSpeed);
  }
  const application: RequestListener = createMswApp(
    ...handlers,
    ...createFallbackHandlers(handlers),
  );
  const feeds = new FeedHub(mockState);
  const server = createHttpServer(
    withCors(feeds.wrap(application), () => mockState.config.corsOrigins),
  );
  const hub = new RunSocketHub(mockState);
  hub.attach(server);

  const host = options.host ?? LOOPBACK_HOST;
  await listen(server, options.port ?? MOCK_DEFAULT_PORT, host);
  const { port } = server.address() as AddressInfo;

  return {
    server,
    hub,
    feeds,
    port,
    baseUrl: `http://${host}:${port}`,
    wsBaseUrl: `ws://${host}:${port}`,
    close: async () => {
      hub.closeAll();
      feeds.closeAll();
      await closeServer(server);
    },
  };
}
