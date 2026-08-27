import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD } from "../src/channel";
import type { InboxSettings, ServerConfig } from "../src/config";
import { Redactor } from "../src/redact";
import { createTessaServer } from "../src/server";
import { IDS, TOKEN, agentSession } from "./fixtures";
import { FINDING, RUN, TARGET, frame, hello, json, recordingClock, startSse, startStub, until, type Stub } from "./sse-stub";

const channelNotification = z.object({
  method: z.literal(CHANNEL_METHOD),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
});

type Notification = z.infer<typeof channelNotification>;

let stub: Stub;
let directory: string;

beforeEach(async () => {
  stub = await startStub();
  directory = await mkdtemp(join(tmpdir(), "tessa-channel-"));
  stub.route("POST /api/v1/agent-sessions", (_request, response) => json(response, 201, agentSession));
  stub.route("PATCH /api/v1/agent-sessions/" + IDS.agentSession, (_request, response) => json(response, 200, agentSession));
  stub.route("GET /api/v1/coverage", (_request, response) => json(response, 200, { totals: { needs_author: 0 }, cells: [] }));
  stub.route("GET /api/v1/feeds/runs", (_request, response) => startSse(response, hello("runs")));
  stub.route("GET /api/v1/feeds/coverage", (_request, response) => startSse(response, hello("coverage")));
  stub.route("GET /api/v1/feeds/findings", (_request, response) => {
    startSse(
      response,
      hello("findings"),
      frame("finding.created", { finding_id: FINDING, title: "Overbooking <b>possible</b>", class: "bug", severity: "high", status: "open", fingerprint: "f", is_new: true, scenario_id: null }, { run_id: RUN, seq: 1 }),
    );
  });
});

afterEach(async () => {
  await stub.close();
  await rm(directory, { recursive: true, force: true });
});

async function connect(settings: Partial<InboxSettings>) {
  const config: ServerConfig = { baseUrl: stub.url, token: TOKEN, problem: null, cwd: "C:\\work\\hotel-app", claudeSessionId: "claude-session-9" };
  const redactor = new Redactor();
  const tessa = createTessaServer({
    config,
    pluginVersion: "0.1.0",
    logger: () => undefined,
    redactor,
    clock: recordingClock(),
    inbox: { dataDir: directory, watch: [], channel: false, feeds: false, random: () => 0.5, ...settings },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const notifications: Notification[] = [];
  client.setNotificationHandler(channelNotification, (notification) => {
    notifications.push(notification as Notification);
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([tessa.mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { tessa, client, notifications };
}

describe("channel", () => {
  it("is not declared while the switch is off", async () => {
    const { client, tessa } = await connect({ channel: false });
    expect(client.getServerCapabilities()?.experimental?.["claude/channel"]).toBeUndefined();
    expect(client.getInstructions()).toBeUndefined();
    await tessa.inbox.stop();
  });

  it("is declared with its instructions when the switch is on", async () => {
    const { client, tessa } = await connect({ channel: true });
    expect(client.getServerCapabilities()?.experimental?.["claude/channel"]).toEqual({});
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toBe(CHANNEL_INSTRUCTIONS);
    expect(CHANNEL_INSTRUCTIONS).toContain('<channel source="tessa"');
    expect(CHANNEL_INSTRUCTIONS).toMatch(/one-way/);
    await tessa.inbox.stop();
  });

  it("emits a notification for a delivered line only when enabled", async () => {
    const off = await connect({ channel: false });
    await off.tessa.inbox.deliver({ kind: "finding.created", targetId: TARGET, id: FINDING, text: "high bug 'x'", dedupeKey: "k1" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(off.notifications).toHaveLength(0);
    expect(await off.tessa.inboxStore.read()).toHaveLength(1);
    await off.tessa.inbox.stop();

    const on = await connect({ channel: true });
    await on.tessa.inbox.deliver({ kind: "finding.created", targetId: TARGET, id: FINDING, text: "high bug 'x'", dedupeKey: "k2" });
    await until(() => on.notifications.length === 1);
    expect(on.notifications[0]?.params.meta).toEqual({ kind: "finding.created", target_id: TARGET, id: FINDING });
    expect(on.notifications[0]?.params.content).toBe(`kind=finding.created target=${TARGET} id=${FINDING} high bug 'x'`);
    await on.tessa.inbox.stop();
  });

  it("pushes a feed event end to end into the channel, the inbox file and the tool", async () => {
    const { client, tessa, notifications } = await connect({ channel: true, feeds: true, watch: [TARGET] });
    await until(() => notifications.length === 1);
    const notification = notifications[0] as Notification;
    expect(notification.params.meta.kind).toBe("finding.created");
    expect(notification.params.meta.id).toBe(FINDING);
    expect(notification.params.content).not.toMatch(/[<>]/);

    const inboxFile = join(directory, "inbox", "claude-session-9.jsonl");
    const written = (await readFile(inboxFile, "utf8")).trim().split("\n");
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] as string).line).toBe(notification.params.content);

    const result = await client.callTool({ name: "inbox", arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    expect(body.count).toBe(1);
    expect(body.lines[0]).toContain(`id=${FINDING}`);
    await tessa.inbox.stop();
  });

  it("does not push while no target is watched", async () => {
    const { tessa } = await connect({ channel: true, feeds: true, watch: [] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stub.requests.filter((entry) => entry.path.startsWith("/api/v1/feeds"))).toHaveLength(0);
    await tessa.inbox.stop();
  });
});

describe("inbox tool", () => {
  it("returns the pending lines without removing them, then clears on request", async () => {
    const { client, tessa } = await connect({});
    await tessa.inboxStore.append(["kind=finding.created target=t id=i first", "kind=run.finished target=t id=r second <b>"], "2026-10-09T10:00:00Z");

    const read = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "inbox", arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    };
    const first = await read({});
    expect(first.count).toBe(2);
    expect(first.cleared).toBe(false);
    expect(first.lines[1]).not.toMatch(/[<>]/);
    expect((await read({})).count).toBe(2);
    const cleared = await read({ clear: true });
    expect(cleared.count).toBe(2);
    expect(cleared.cleared).toBe(true);
    expect((await read({})).count).toBe(0);
    await tessa.inbox.stop();
  });
});

describe("session file", () => {
  it("is written when the agent session is created, for the hooks to find", async () => {
    const { tessa } = await connect({});
    await tessa.session.settled();
    await until(async () => {
      try {
        await readFile(join(directory, "sessions", "claude-session-9.json"), "utf8");
        return true;
      } catch {
        return false;
      }
    });
    const record = JSON.parse(await readFile(join(directory, "sessions", "claude-session-9.json"), "utf8"));
    expect(record.agent_session_id).toBe(IDS.agentSession);
    expect(record.claude_session_id).toBe("claude-session-9");
    expect(JSON.stringify(record)).not.toContain(TOKEN);
    await tessa.inbox.stop();
  });

  it("is not written, and nothing fails, without a plugin data directory", async () => {
    const { tessa } = await connect({ dataDir: null });
    await tessa.session.settled();
    expect(tessa.session.state.id).toBe(IDS.agentSession);
    await tessa.inbox.stop();
  });
});
