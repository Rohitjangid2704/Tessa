import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentSession,
  AgentSessionPage,
  AuditEventPage,
  BundleValidationReport,
  PersonalTokenCreated,
  PersonalTokenList,
} from "@/lib/api/types";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import type { RunningMockServer } from "@/mocks/server/http";
import { UPLOAD_FILE_NAMES } from "@/mocks/stage1/outcomes";
import { agentSessionsStore } from "@/mocks/stage11/agent-sessions-store";
import { explanationsStore } from "@/mocks/stage11/explanations-store";
import { TOKEN_LIMIT, TOKEN_MAX_DAYS } from "@/mocks/stage11/tokens-data";
import { tokensStore } from "@/mocks/stage11/tokens-store";
import { stageEight } from "@/mocks/stage8/store";
import { mockState } from "@/mocks/state";
import { startMockApi } from "@/tests/utils/mock-api";
import {
  createStage1Client,
  errorOf,
  STAGE_ONE_IDS,
  type Stage1Client,
} from "@/tests/utils/stage1";

let running: RunningMockServer;
let client: Stage1Client;

beforeAll(async () => {
  running = await startMockApi();
  client = createStage1Client(running.baseUrl);
});

afterAll(async () => {
  await running.close();
});

beforeEach(() => {
  mockState.reset();
});

const TOKENS_PATH = "/api/v1/users/me/tokens";
const SECRET_PATTERN = /^ipt_[A-Za-z0-9_-]{43}$/;
const MISSING_ID = "0198f6f2-4c2a-7d10-9c1e-000000000000";

async function mint(
  name: string,
  body: Record<string, unknown> = {},
  role?: "admin" | "member" | "viewer",
): Promise<Response> {
  return client.send("POST", TOKENS_PATH, { name, ...body }, { role });
}

async function mintOk(name: string, role?: "admin" | "member" | "viewer") {
  const response = await mint(name, {}, role);
  expect(response.status).toBe(201);
  return (await response.json()) as PersonalTokenCreated;
}

async function listTokens(role?: "admin" | "member" | "viewer") {
  return (await (await client.get(TOKENS_PATH, role)).json()) as PersonalTokenList;
}

function withToken(secret: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${secret}`, ...extra };
}

describe("personal tokens", () => {
  it("mints a fresh ipt_ token once and lists only the prefix afterwards", async () => {
    const created = await mintOk("laptop");
    expect(created.token).toMatch(SECRET_PATTERN);
    expect(created.item).toMatchObject({
      name: "laptop",
      prefix: created.token.slice(0, 8),
      revoked_at: null,
      last_used_at: null,
    });

    const second = await mintOk("desktop");
    expect(second.token).not.toBe(created.token);

    const listed = await listTokens();
    expect(listed.items.map((item) => item.name).sort()).toEqual(["desktop", "laptop"]);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain(second.token);
  });

  it("scopes tokens to the caller", async () => {
    await mintOk("admin token", "admin");
    await mintOk("viewer token", "viewer");
    expect((await listTokens("admin")).items.map((item) => item.name)).toEqual(["admin token"]);
    expect((await listTokens("viewer")).items.map((item) => item.name)).toEqual(["viewer token"]);
  });

  it("defaults the lifetime to the server maximum and honours a shorter one", async () => {
    const defaulted = await mintOk("default");
    const days =
      (Date.parse(defaulted.item.expires_at) - Date.parse(defaulted.item.created_at)) / 86_400_000;
    expect(Math.round(days)).toBe(TOKEN_MAX_DAYS);

    const shortResponse = await mint("week", { expires_in_days: 7 });
    const short = (await shortResponse.json()) as PersonalTokenCreated;
    const shortDays =
      (Date.parse(short.item.expires_at) - Date.parse(short.item.created_at)) / 86_400_000;
    expect(Math.round(shortDays)).toBe(7);
  });

  it("rejects an expiry above the maximum with the maximum named in the details", async () => {
    const response = await mint("too long", { expires_in_days: TOKEN_MAX_DAYS + 1 });
    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect(error.details).toContainEqual(
      expect.objectContaining({
        loc: ["body", "expires_in_days"],
        code: "less_than_equal",
        message: `Input should be less than or equal to ${TOKEN_MAX_DAYS}`,
      }),
    );
  });

  it("validates the name", async () => {
    expect((await mint("")).status).toBe(422);
    expect((await mint("x".repeat(61))).status).toBe(422);
    expect((await client.send("POST", TOKENS_PATH, {})).status).toBe(422);
  });

  it("answers 409 token_limit once ten tokens are live, and frees a slot on revoke", async () => {
    const created: PersonalTokenCreated[] = [];
    for (let index = 0; index < TOKEN_LIMIT; index += 1) {
      created.push(await mintOk(`token ${index}`));
    }
    const refused = await mint("one too many");
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("token_limit");

    const first = created[0];
    expect(first).toBeDefined();
    const revoked = await client.send("DELETE", `${TOKENS_PATH}/${first?.item.id}`);
    expect(revoked.status).toBe(204);
    expect((await mint("fits now")).status).toBe(201);
  });

  it("revokes a token, keeps the row as revoked and refuses it as a bearer", async () => {
    const created = await mintOk("to revoke");
    expect((await client.send("DELETE", `${TOKENS_PATH}/${created.item.id}`)).status).toBe(204);
    const listed = await listTokens();
    expect(listed.items[0]?.revoked_at).not.toBeNull();

    const response = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: withToken(created.token),
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("token_revoked");
  });

  it("answers 404 when revoking a token that is not the caller's", async () => {
    const created = await mintOk("admin only", "admin");
    const response = await client.send("DELETE", `${TOKENS_PATH}/${created.item.id}`, undefined, {
      role: "member",
    });
    expect(response.status).toBe(404);
    expect((await client.send("DELETE", `${TOKENS_PATH}/${MISSING_ID}`)).status).toBe(404);
  });

  it("lets an admin list and revoke another user's tokens and nobody else", async () => {
    const created = await mintOk("member token", "member");
    const listPath = `/api/v1/users/${MEMBER_USER.id}/tokens`;
    const listed = (await (await client.get(listPath)).json()) as PersonalTokenList;
    expect(listed.items.map((item) => item.id)).toEqual([created.item.id]);
    expect((await client.get(listPath, "member")).status).toBe(403);
    expect(
      (await client.send("DELETE", `${listPath}/${created.item.id}`, undefined, { role: "member" }))
        .status,
    ).toBe(403);
    expect((await client.send("DELETE", `${listPath}/${created.item.id}`)).status).toBe(204);
    expect((await listTokens("member")).items[0]?.revoked_at).not.toBeNull();
  });

  it("authenticates as the owner and stamps last_used_at", async () => {
    const created = await mintOk("viewer laptop", "viewer");
    const response = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: withToken(created.token),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: VIEWER_USER.id, role: "viewer" });
    expect((await listTokens("viewer")).items[0]?.last_used_at).not.toBeNull();
  });

  it("refuses an unknown or expired ipt_ bearer", async () => {
    const unknown = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: withToken(`ipt_${"A".repeat(43)}`),
    });
    expect(unknown.status).toBe(401);

    tokensStore.load("expired");
    const expired = tokensStore
      .listOf(MEMBER_USER.id)
      .find((token) => token.name === "old ci runner");
    expect(expired).toBeDefined();
    const secret = tokensStore.secretOf(expired?.id ?? "");
    const response = await fetch(`${running.baseUrl}/api/v1/users/me`, {
      headers: withToken(secret ?? ""),
    });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe("token_expired");
  });
});

async function createSession(role: "admin" | "member" = "member") {
  return client.send(
    "POST",
    "/api/v1/agent-sessions",
    { claude_session_id: "abc", cwd_label: "repo", plugin_version: "0.1.0" },
    { role },
  );
}

describe("audit of writes made with a personal token", () => {
  async function auditEvents(query = ""): Promise<AuditEventPage> {
    return (await (await client.get(`/api/v1/audit-events${query}`)).json()) as AuditEventPage;
  }

  it("records a successful write as personal_token_write via mcp and links the agent session", async () => {
    const created = await mintOk("claude", "member");
    const sessionResponse = await fetch(`${running.baseUrl}/api/v1/agent-sessions`, {
      method: "POST",
      headers: withToken(created.token, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        claude_session_id: "session-1",
        cwd_label: "gracie",
        plugin_version: "0.1.0",
        target_id: STAGE_ONE_IDS.gracie,
      }),
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as AgentSession;
    expect(session.user_id).toBe(MEMBER_USER.id);

    const before = (await auditEvents()).items.length;
    const failed = await fetch(`${running.baseUrl}/api/v1/agent-sessions/${MISSING_ID}`, {
      method: "PATCH",
      headers: withToken(created.token, {
        "Content-Type": "application/json",
        "X-Agent-Session": session.id,
      }),
      body: JSON.stringify({ summary: "nope" }),
    });
    expect(failed.status).toBe(404);
    expect((await auditEvents()).items).toHaveLength(before);

    const patch = await fetch(`${running.baseUrl}/api/v1/agent-sessions/${session.id}`, {
      method: "PATCH",
      headers: withToken(created.token, {
        "Content-Type": "application/json",
        "X-Agent-Session": session.id,
      }),
      body: JSON.stringify({ summary: "explained one finding" }),
    });
    expect(patch.status).toBe(200);

    const events = await auditEvents(`?agent_session_id=${session.id}`);
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({
      action: "personal_token_write",
      via: "mcp",
      actor_user_id: MEMBER_USER.id,
      subject_id: session.id,
      detail: { method: "PATCH", status: 200 },
    });
    expect(JSON.stringify(events)).not.toContain(created.token);
    expect(agentSessionsStore.find(session.id)?.write_count).toBe(1);
  });

  it("does not record reads or writes made with a web token", async () => {
    const created = await mintOk("claude", "member");
    const countWrites = async () =>
      (await auditEvents("?via=mcp")).items.filter(
        (event) => event.action === "personal_token_write",
      ).length;
    const before = await countWrites();
    await fetch(`${running.baseUrl}/api/v1/agent-sessions`, { headers: withToken(created.token) });
    await createSession();
    expect(await countWrites()).toBe(before);
  });

  it("records token creation and revocation as web events", async () => {
    const created = await mintOk("audited", "admin");
    await client.send("DELETE", `${TOKENS_PATH}/${created.item.id}`);
    const events = await auditEvents(`?subject_id=${created.item.id}`);
    expect(events.items.map((event) => event.action).sort()).toEqual([
      "token_created",
      "token_revoked",
    ]);
    expect(events.items.every((event) => event.via === "web")).toBe(true);
  });

  it("filters by via and is admin only", async () => {
    const mcp = await auditEvents("?via=mcp");
    expect(mcp.items.length).toBeGreaterThan(0);
    expect(mcp.items.every((event) => event.via === "mcp")).toBe(true);
    expect((await client.get("/api/v1/audit-events", "member")).status).toBe(403);
    expect((await client.get("/api/v1/audit-events?via=nope")).status).toBe(422);
  });
});

describe("agent sessions", () => {
  it("delivers agent_session.changed to a client on the home feed", async () => {
    const controller = new AbortController();
    const response = await fetch(`${running.baseUrl}/api/v1/feeds/home`, {
      headers: await client.headers(),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let received = "";
    const created = (await (await createSession()).json()) as AgentSession;
    const deadline = Date.now() + 5000;
    while (!received.includes("event: agent_session.changed") && Date.now() < deadline) {
      const chunk = await reader?.read();
      received += decoder.decode(chunk?.value);
    }
    controller.abort();
    expect(received).toContain("event: agent_session.changed");
    expect(received).toContain(created.id);
  });

  it("creates, lists and ends a session and announces each change on the home bus", async () => {
    const announced: object[] = [];
    const unsubscribe = stageEight.bus.subscribe((envelope) => {
      if (envelope.type === "agent_session.changed") {
        announced.push(envelope.payload);
      }
    });
    const created = (await (await createSession()).json()) as AgentSession;
    expect(created).toMatchObject({ user_id: MEMBER_USER.id, ended_at: null, write_count: 0 });

    const active = (await (
      await client.get(`/api/v1/agent-sessions?user_id=${MEMBER_USER.id}&active=true`)
    ).json()) as AgentSessionPage;
    expect(active.items.map((item) => item.id)).toContain(created.id);

    const ended = await client.send(
      "PATCH",
      `/api/v1/agent-sessions/${created.id}`,
      { ended_at: new Date().toISOString(), summary: "done" },
      { role: "member" },
    );
    expect(ended.status).toBe(200);
    unsubscribe();
    expect(announced).toEqual([
      expect.objectContaining({ agent_session_id: created.id, active: true }),
      expect.objectContaining({ agent_session_id: created.id, active: false }),
    ]);
    const inactive = (await (
      await client.get("/api/v1/agent-sessions?active=false")
    ).json()) as AgentSessionPage;
    expect(inactive.items.map((item) => item.id)).toContain(created.id);
  });

  it("lets only the owner or an admin change a session and members create", async () => {
    const created = (await (await createSession("member")).json()) as AgentSession;
    const byViewer = await client.send(
      "PATCH",
      `/api/v1/agent-sessions/${created.id}`,
      { summary: "x" },
      { role: "viewer" },
    );
    expect(byViewer.status).toBe(403);
    expect((await createSession("admin")).status).toBe(201);
    const viewerCreate = await client.send(
      "POST",
      "/api/v1/agent-sessions",
      { claude_session_id: "abc", cwd_label: "repo", plugin_version: "0.1.0" },
      { role: "viewer" },
    );
    expect(viewerCreate.status).toBe(403);
  });

  it("validates the body", async () => {
    const response = await client.send(
      "POST",
      "/api/v1/agent-sessions",
      { cwd_label: "repo", plugin_version: "0.1.0" },
      { role: "member" },
    );
    expect(response.status).toBe(422);
  });
});

describe("POST /bundles/validate", () => {
  async function validate(name: string, targetId?: string, role?: "admin" | "member" | "viewer") {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], name, { type: "application/zip" }),
    );
    if (targetId !== undefined) {
      form.set("target_id", targetId);
    }
    return fetch(`${running.baseUrl}/api/v1/bundles/validate`, {
      method: "POST",
      headers: await client.headers(role),
      body: form,
    });
  }

  it("reports a valid bundle without storing a version", async () => {
    const before = mockState.stageOne.bundlesOf(STAGE_ONE_IDS.billing).length;
    const response = await validate(UPLOAD_FILE_NAMES.valid, STAGE_ONE_IDS.billing);
    expect(response.status).toBe(200);
    const report = (await response.json()) as BundleValidationReport;
    expect(report.validation_status).toBe("valid");
    expect(report.completeness.status).toBe("meets_bar");
    expect(report.errors).toEqual([]);
    expect(report.proposal).toBeNull();
    expect(report.fixup_items.length).toBeGreaterThan(0);
    expect(
      report.fixup_items.every((item) => item.kind === "check" || item.kind === "warning"),
    ).toBe(true);
    expect(report.fixup_items.find((item) => item.kind === "check")?.fix_hint).not.toBe("");
    expect(mockState.stageOne.bundlesOf(STAGE_ONE_IDS.billing)).toHaveLength(before);
  });

  it("lists the errors of an invalid bundle first in fixup_items", async () => {
    const report = (await (
      await validate(UPLOAD_FILE_NAMES.invalid, STAGE_ONE_IDS.billing)
    ).json()) as BundleValidationReport;
    expect(report.validation_status).toBe("invalid");
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.fixup_items[0]?.kind).toBe("error");
    expect(report.fixup_items.filter((item) => item.kind === "error")).toHaveLength(
      report.errors.length,
    );
    expect(report.diff_summary).toBeNull();
  });

  it("diffs against the newest valid bundle of the target", async () => {
    const report = (await (
      await validate(UPLOAD_FILE_NAMES.valid, STAGE_ONE_IDS.gracie)
    ).json()) as BundleValidationReport;
    expect(report.diff_summary).not.toBeNull();
  });

  it("adds a proposal summary when the file name carries the proposal marker", async () => {
    const report = (await (await validate("valid-proposal.zip")).json()) as BundleValidationReport;
    expect(report.proposal).toMatchObject({ items: 8, warnings: [] });
  });

  it("refuses secrets, a file that is not a zip and a viewer", async () => {
    const secret = await validate(UPLOAD_FILE_NAMES.secret);
    expect(secret.status).toBe(422);
    expect((await errorOf(secret)).code).toBe("bundle_contains_secret");

    const notZip = new FormData();
    notZip.set("file", new File(["text"], UPLOAD_FILE_NAMES.notAZip, { type: "text/plain" }));
    const refused = await fetch(`${running.baseUrl}/api/v1/bundles/validate`, {
      method: "POST",
      headers: await client.headers(),
      body: notZip,
    });
    expect(refused.status).toBe(415);

    expect((await validate(UPLOAD_FILE_NAMES.valid, undefined, "viewer")).status).toBe(403);
    expect((await validate(UPLOAD_FILE_NAMES.valid, MISSING_ID)).status).toBe(404);
  });
});

describe("POST /__mock/stage11/seed", () => {
  async function seed(body: unknown): Promise<Response> {
    return fetch(`${running.baseUrl}/__mock/stage11/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("starts with no tokens and fills them with the tokens variant", async () => {
    expect((await listTokens()).items).toEqual([]);
    expect((await seed({ variants: { tokens: "full" } })).status).toBe(200);
    expect((await listTokens()).items).toHaveLength(TOKEN_LIMIT);
    expect((await mint("over the limit")).status).toBe(409);
  });

  it("seeds an expired and a revoked token with the expired variant", async () => {
    await seed({ variants: { tokens: "expired" } });
    const items = (await listTokens()).items;
    const now = Date.now();
    expect(items.some((item) => item.revoked_at !== null)).toBe(true);
    expect(
      items.some((item) => item.revoked_at === null && Date.parse(item.expires_at) < now),
    ).toBe(true);
    expect(
      items.some((item) => item.revoked_at === null && Date.parse(item.expires_at) > now),
    ).toBe(true);
  });

  it("empties sessions and audit with seed empty and stores the explanations variant", async () => {
    const response = await seed({ seed: "empty", variants: { explanations: "structured" } });
    expect(response.status).toBe(200);
    expect(explanationsStore.variant).toBe("structured");
    expect(
      ((await (await client.get("/api/v1/audit-events")).json()) as AuditEventPage).items,
    ).toEqual([]);
    expect(
      ((await (await client.get("/api/v1/agent-sessions")).json()) as AgentSessionPage).items,
    ).toEqual([]);
  });

  it("rejects an unknown seeder or variant", async () => {
    expect((await seed({ variants: { nope: "x" } })).status).toBe(422);
    expect((await seed({ variants: { tokens: "nope" } })).status).toBe(422);
    expect((await seed({})).status).toBe(422);
  });

  it("resets with the mock state", async () => {
    await seed({ variants: { tokens: "full", explanations: "structured" } });
    mockState.reset();
    expect((await listTokens()).items).toEqual([]);
    expect(explanationsStore.variant).toBe("text");
  });
});
