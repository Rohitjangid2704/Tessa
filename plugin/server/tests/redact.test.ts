import { describe, expect, it } from "vitest";
import { REDACTED, Redactor, isSecretKey, plain } from "../src/redact";

const FULL_TOKEN = "ipt_Zk3pQ9xLm2Vb7Ncw4TyHs8dRf1JgAe6UoXiKq5BnPaM";

type Row = { name: string; input: unknown; expected: unknown };

const rows: Row[] = [
  { name: "personal token inside text", input: `token is ${FULL_TOKEN} ok`, expected: `token is ${REDACTED} ok` },
  { name: "bearer header value", input: "Authorization: Bearer abc.def-123_xyz", expected: `Authorization: Bearer ${REDACTED}` },
  { name: "lowercase bearer", input: "bearer eyJhbGciOi.payload.sig", expected: `bearer ${REDACTED}` },
  { name: "password key", input: { password: "hunter2hunter2" }, expected: { password: REDACTED } },
  { name: "nested secret key", input: { db: { client_secret: "s3cr3t-value" } }, expected: { db: { client_secret: REDACTED } } },
  { name: "dsn key", input: { dsn: "postgres://user:pw@host/db" }, expected: { dsn: REDACTED } },
  { name: "camel case api key", input: { apiKey: "sk-live-123456" }, expected: { apiKey: REDACTED } },
  { name: "token key in an array item", input: [{ access_token: "abcdef123456" }], expected: [{ access_token: REDACTED }] },
  { name: "secret list values", input: { secrets: ["alpha-value", "beta-value"] }, expected: { secrets: [REDACTED, REDACTED] } },
  { name: "numbers under a secret key stay", input: { tokens: 12, max_token_count: 3 }, expected: { tokens: 12, max_token_count: 3 } },
  { name: "target token stays readable", input: { target_token: "tgt_graphqlfixture22222222" }, expected: { target_token: "tgt_graphqlfixture22222222" } },
  { name: "ordinary text is untouched", input: { title: "Create issue", keywords: ["a", "b"], has_value: true }, expected: { title: "Create issue", keywords: ["a", "b"], has_value: true } },
];

describe("redaction table", () => {
  it("has twelve rows", () => {
    expect(rows).toHaveLength(12);
  });

  it.each(rows)("$name", ({ input, expected }) => {
    expect(new Redactor().value(input)).toEqual(expected);
  });
});

describe("redactor", () => {
  it("masks registered literal values in any string", () => {
    const redactor = new Redactor();
    redactor.addLiteral("super-secret-value");
    expect(redactor.value({ message: "failed with super-secret-value here" })).toEqual({
      message: `failed with ${REDACTED} here`,
    });
  });

  it("ignores literals that are too short to mask safely", () => {
    const redactor = new Redactor();
    redactor.addLiteral("abc");
    expect(redactor.text("abc def")).toBe("abc def");
  });

  it("keeps the display prefix of a personal token readable", () => {
    expect(new Redactor().text("prefix ipt_Zk3p")).toBe("prefix ipt_Zk3p");
  });

  it("keeps a value marked plain readable under a secret-looking key but still masks tokens and literals", () => {
    const redactor = new Redactor();
    redactor.addLiteral("super-secret-value");
    const output = redactor.value({
      key: plain("billing.refund.partial"),
      other: { key: "sk-live-123456" },
      leaked: { key: plain(`x ${FULL_TOKEN} super-secret-value`) },
    });
    expect(output.key).toBe("billing.refund.partial");
    expect(output.other).toEqual({ key: REDACTED });
    expect(output.leaked.key).toBe(`x ${REDACTED} ${REDACTED}`);
    expect(JSON.stringify({ key: plain("a.b.c") })).toBe('{"key":"a.b.c"}');
  });

  it("classifies keys by word", () => {
    expect(isSecretKey("SMTP_PASSWORD")).toBe(true);
    expect(isSecretKey("authorization")).toBe(true);
    expect(isSecretKey("keywords")).toBe(false);
    expect(isSecretKey("monkey")).toBe(false);
  });
});
