import http from "node:http";
import type { AddressInfo } from "node:net";

const LOOPBACK = "127.0.0.1";
const OK_PATHS = new Set(["/", "/health", "/api/chat/health", "/api/admin/health"]);

export interface FakeTarget {
  origin: string;
  requests: string[];
  stop: () => Promise<void>;
}

export async function startFakeTarget(): Promise<FakeTarget> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${LOOPBACK}`).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (OK_PATHS.has(pathname)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${LOOPBACK}:${port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

export async function unusedPortOrigin(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://${LOOPBACK}:${port}`;
}
