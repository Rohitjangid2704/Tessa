import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools";
import { BASE_URL, IDS, TOKEN, errorBody } from "./fixtures";
import { createHarness, mswServer, requestsTo, resetSeen } from "./harness";

const EXPECTED_TOOLS = [
  "whoami",
  "list_targets",
  "get_target",
  "issue_prompt",
  "validate_bundle",
  "upload_bundle",
  "get_bundle",
  "get_environment",
  "set_environment",
  "run_health_checks",
  "start_run",
  "wait_run",
  "get_run",
  "get_step",
  "run_diff",
  "cancel_run",
  "list_findings",
  "get_finding",
  "add_explanation",
  "move_finding",
  "get_proposal",
  "put_proposal",
  "update_proposal_item",
  "plan_from_proposal",
  "get_coverage",
  "validate_scenario",
  "list_scenarios",
  "inbox",
];

const READ_TOOLS = [
  "whoami",
  "list_targets",
  "get_target",
  "validate_bundle",
  "get_bundle",
  "get_environment",
  "wait_run",
  "get_run",
  "get_step",
  "run_diff",
  "list_findings",
  "get_finding",
  "get_proposal",
  "get_coverage",
  "validate_scenario",
  "list_scenarios",
  "inbox",
];

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());
beforeEach(() => resetSeen());

async function connect() {
  const harness = createHarness();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([harness.mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { harness, client };
}

describe("tool registry", () => {
  it("defines the twenty-eight tools in order, once each", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(new Set(TOOLS.map((tool) => tool.name)).size).toBe(28);
  });

  it("marks exactly the planned tools as read tools", () => {
    expect(TOOLS.filter((tool) => tool.access === "read").map((tool) => tool.name).sort()).toEqual(
      [...READ_TOOLS].sort(),
    );
  });

  it("describes every tool as Read or Write", () => {
    for (const tool of TOOLS) {
      expect(tool.description.startsWith(tool.access === "read" ? "Read" : "Write"), tool.name).toBe(true);
    }
  });
});

describe("over the MCP protocol", () => {
  it("lists the tools with annotations", async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of listed.tools) {
      const isRead = READ_TOOLS.includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(isRead);
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
    }
    const cancel = listed.tools.find((tool) => tool.name === "cancel_run");
    expect(cancel?.annotations?.destructiveHint).toBe(true);
    const whoami = listed.tools.find((tool) => tool.name === "whoami");
    expect(whoami?.annotations?.destructiveHint).toBe(false);
  });

  it("offers reset_seed on start_run and says when to pass it", async () => {
    const { client } = await connect();
    const startRun = (await client.listTools()).tools.find((tool) => tool.name === "start_run");
    const resetSeed = (startRun?.inputSchema.properties as Record<string, { type?: string; description?: string }>).reset_seed;
    expect(resetSeed?.type).toBe("boolean");
    expect(resetSeed?.description).toMatch(/seed/);
    expect(startRun?.inputSchema.required ?? []).not.toContain("reset_seed");
    expect(startRun?.description).toMatch(/reset_seed/);
  });

  it("calls a tool without arguments and one with arguments", async () => {
    const { client } = await connect();
    const who = await client.callTool({ name: "whoami", arguments: {} });
    const whoText = (who.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(whoText).user.id).toBe(IDS.user);
    expect(whoText).not.toContain(TOKEN);

    const targets = await client.callTool({ name: "list_targets", arguments: { limit: 5 } });
    expect(targets.isError).toBeFalsy();
  });

  it("returns a tool error result for an api failure", async () => {
    mswServer.use(
      http.get(`${BASE_URL}/api/v1/runs/:runId`, () =>
        HttpResponse.json(errorBody("not_found", "No such run"), { status: 404 }),
      ),
    );
    const { client } = await connect();
    const result = await client.callTool({ name: "get_run", arguments: { run_id: IDS.run } });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    expect(result.isError).toBe(true);
    expect(body.error).toMatchObject({ code: "not_found", status: 404, requestId: "req-fixture-1" });
  });

  it("creates the agent session when the client has initialized", async () => {
    const { harness } = await connect();
    await harness.session.settled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.session.settled();
    expect(requestsTo("POST", "/agent-sessions")).toHaveLength(1);
    expect(harness.session.state.id).toBe(IDS.agentSession);
  });

  it("does not create a session when the plugin is not configured", async () => {
    const harness = createHarness({ config: { token: "", problem: "TESSA_TOKEN is not set" } });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([harness.mcp.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    const body = JSON.parse((result.content as Array<{ text: string }>)[0]?.text ?? "{}");
    expect(result.isError).toBe(true);
    expect(body.error.code).toBe("not_configured");
    expect(requestsTo("POST", "/agent-sessions")).toHaveLength(0);
  });
});
