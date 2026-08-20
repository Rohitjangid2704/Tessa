import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvText } from "../scripts/check-env.mjs";
import {
  clientEnvKeys,
  clientEnvSchema,
  describeEnvIssues,
  e2eEnvKeys,
  e2eEnvSchema,
  pickEnv,
  serverEnvKeys,
  serverEnvSchema,
} from "./env.schema";

const exampleText = readFileSync(path.resolve(import.meta.dirname, "../.env.example"), "utf8");

const exampleValues: Record<string, string> = Object.fromEntries(
  exampleText
    .split(/\r?\n/)
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

const validServerEnv = pickEnv(exampleValues, serverEnvKeys);

describe("env schemas and .env.example", () => {
  it("cover exactly the keys listed in .env.example", () => {
    const { assigned, commented } = parseEnvText(exampleText);
    const schemaKeys = [...clientEnvKeys, ...serverEnvKeys, ...e2eEnvKeys].sort();
    expect([...assigned, ...commented].sort()).toEqual(schemaKeys);
  });

  it("accept the values in .env.example", () => {
    expect(clientEnvSchema.safeParse(pickEnv(exampleValues, clientEnvKeys)).success).toBe(true);
    expect(serverEnvSchema.safeParse(validServerEnv).success).toBe(true);
    expect(e2eEnvSchema.safeParse(pickEnv(exampleValues, e2eEnvKeys)).success).toBe(true);
  });

  it("treats AUTH_TRUST_HOST as optional", () => {
    const absent = serverEnvSchema.parse(validServerEnv);
    const present = serverEnvSchema.parse({ ...validServerEnv, AUTH_TRUST_HOST: "true" });
    expect(absent.AUTH_TRUST_HOST).toBe(false);
    expect(present.AUTH_TRUST_HOST).toBe(true);
  });
});

describe("serverEnvSchema", () => {
  it("rejects unknown keys", () => {
    expect(serverEnvSchema.safeParse({ ...validServerEnv, AUTH_UNKNOWN: "x" }).success).toBe(false);
  });

  it("rejects an AUTH_SECRET equal to API_JWT_SECRET", () => {
    const result = serverEnvSchema.safeParse({
      ...validServerEnv,
      AUTH_SECRET: validServerEnv.API_JWT_SECRET,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an AUTH_SECRET equal to API_SERVICE_KEY", () => {
    const result = serverEnvSchema.safeParse({
      ...validServerEnv,
      AUTH_SECRET: validServerEnv.API_SERVICE_KEY,
    });
    expect(result.success).toBe(false);
  });

  it("rejects secrets shorter than 32 characters", () => {
    expect(
      serverEnvSchema.safeParse({ ...validServerEnv, API_JWT_SECRET: "too-short" }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...validServerEnv, API_SERVICE_KEY: "too-short" }).success,
    ).toBe(false);
  });

  it("rejects a token lifetime that leaves no room for the 60 second refresh margin", () => {
    expect(
      serverEnvSchema.safeParse({ ...validServerEnv, API_JWT_TTL_SECONDS: "60" }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...validServerEnv, API_JWT_TTL_SECONDS: "300" }).success,
    ).toBe(true);
  });

  it("rejects missing keys and non-http URLs", () => {
    const { API_INTERNAL_URL: omitted, ...withoutInternalUrl } = validServerEnv;
    expect(omitted).toBeDefined();
    expect(serverEnvSchema.safeParse(withoutInternalUrl).success).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...validServerEnv, API_INTERNAL_URL: "ftp://127.0.0.1" }).success,
    ).toBe(false);
  });

  it("coerces numeric keys and strips trailing slashes from URLs", () => {
    const parsed = serverEnvSchema.parse({
      ...validServerEnv,
      API_INTERNAL_URL: "http://127.0.0.1:8000/",
    });
    expect(parsed.AUTH_SESSION_MAX_AGE_SECONDS).toBe(28800);
    expect(parsed.API_JWT_TTL_SECONDS).toBe(300);
    expect(parsed.API_INTERNAL_URL).toBe("http://127.0.0.1:8000");
  });

  it("never prints the rejected values", () => {
    const rejected = "zzz-rejected-secret-value";
    const result = serverEnvSchema.safeParse({ ...validServerEnv, API_JWT_SECRET: rejected });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = describeEnvIssues("server", result.error);
      expect(message).toContain("API_JWT_SECRET");
      expect(message).not.toContain(rejected);
    }
  });
});

describe("clientEnvSchema", () => {
  it("requires NEXT_PUBLIC_API_URL", () => {
    expect(clientEnvSchema.safeParse({}).success).toBe(false);
    expect(
      clientEnvSchema.safeParse({ NEXT_PUBLIC_API_URL: "http://localhost:8000" }).success,
    ).toBe(true);
  });
});

describe("e2eEnvSchema", () => {
  it("treats empty values as unset", () => {
    const parsed = e2eEnvSchema.parse({
      E2E_BASE_URL: "",
      E2E_USER_EMAIL: "",
      E2E_USER_PASSWORD: "",
      E2E_GRACIE_ZIP: "",
      E2E_GRACIE_ENV_FILE: "",
      E2E_API_DATA_DIR: "",
      E2E_LOG_FILES: "",
    });
    expect(parsed.E2E_GRACIE_ZIP).toBeUndefined();
    expect(parsed.E2E_API_DATA_DIR).toBeUndefined();
    expect(parsed.E2E_LOG_FILES).toBeUndefined();
    expect(parsed.E2E_BASE_URL).toBeUndefined();
  });
});
