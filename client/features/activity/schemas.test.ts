import { describe, expect, it } from "vitest";
import {
  auditFiltersCodec,
  auditFiltersSchema,
  sinceToTimestamp,
  toAuditListFilters,
} from "./schemas";

const ACTOR = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e22";
const SESSION = "0198f6f2-aaaa-7bbb-8ccc-000000000011";

function parse(query: string) {
  return auditFiltersCodec.parse(new URLSearchParams(query));
}

describe("audit filters", () => {
  it("parses every key of the URL", () => {
    const values = parse(
      `actor=${ACTOR}&via=mcp&subject_type=personal_token&since=2026-10-01&session=${SESSION}`,
    );
    expect(values).toEqual({
      actor: ACTOR,
      via: "mcp",
      subject_type: "personal_token",
      since: "2026-10-01",
      session: SESSION,
    });
  });

  it("drops values the API would refuse", () => {
    const values = parse("actor=not-a-uuid&via=ftp&subject_type=planet&since=yesterday&session=1");
    expect(values).toEqual({
      actor: undefined,
      via: undefined,
      subject_type: undefined,
      since: undefined,
      session: undefined,
    });
    expect(parse("since=2026-13-45").since).toBeUndefined();
  });

  it("keeps only the first value of a repeated key", () => {
    expect(parse("via=svc&via=web").via).toBe("svc");
  });

  it("round trips through the URL and counts the active filters", () => {
    const values = parse(`via=web&since=2026-10-01`);
    expect(auditFiltersCodec.serialize(values).toString()).toBe("via=web&since=2026-10-01");
    expect(auditFiltersCodec.activeKeys(values)).toEqual(["via", "since"]);
    expect(auditFiltersCodec.activeKeys(parse(""))).toEqual([]);
  });

  it("exposes the zod schema for the routes", () => {
    expect(auditFiltersSchema.safeParse({ via: ["mcp"] }).success).toBe(true);
    expect(auditFiltersSchema.parse({}).via).toBeUndefined();
  });

  it("maps the URL values to API query names and a timestamp with an offset", () => {
    expect(sinceToTimestamp("2026-10-01")).toBe("2026-10-01T00:00:00Z");
    expect(
      toAuditListFilters(parse(`actor=${ACTOR}&via=svc&since=2026-10-01&session=${SESSION}`)),
    ).toEqual({
      actor_user_id: ACTOR,
      via: "svc",
      subject_type: undefined,
      since: "2026-10-01T00:00:00Z",
      agent_session_id: SESSION,
    });
  });
});
