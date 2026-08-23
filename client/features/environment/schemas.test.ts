import { describe, expect, it } from "vitest";
import { buildEnvironmentVariable } from "@/mocks/factories/environment";
import { defaultFormValues } from "./build-patch";
import {
  ENV_VALUE_MAX_LENGTH,
  HEALTH_CHECK_TIMEOUT_MS,
  createEnvironmentFormSchema,
  normalizeEnvironmentValue,
  usesSwitch,
  validateEnvironmentValue,
} from "./schemas";

const url = { kind: "url", secret: false } as const;
const secretUrl = { kind: "url", secret: true } as const;
const dsn = { kind: "dsn", secret: true } as const;
const number = { kind: "number", secret: false } as const;
const bool = { kind: "bool", secret: false } as const;

describe("validateEnvironmentValue", () => {
  it.each(["https://app.qa.example.test", "http://localhost:8000/path?x=1", "wss://host"])(
    "accepts the URL %s",
    (value) => {
      expect(validateEnvironmentValue(url, value)).toBeNull();
    },
  );

  it.each(["app.qa.example.test", "localhost:8000", "http://", "://host", "not a url"])(
    "rejects %s as a URL",
    (value) => {
      expect(validateEnvironmentValue(url, value)).toBe("Enter a URL like scheme://host");
    },
  );

  it("rejects a plain URL that carries credentials and allows it for a secret one", () => {
    expect(validateEnvironmentValue(url, "https://user:pw@host.test")).toMatch(
      /username or password/,
    );
    expect(validateEnvironmentValue(secretUrl, "https://user:pw@host.test")).toBeNull();
  });

  it("accepts a DSN with credentials and rejects text", () => {
    expect(validateEnvironmentValue(dsn, "postgresql://reader:pw@db.test:5432/app")).toBeNull();
    expect(validateEnvironmentValue(dsn, "postgresql+asyncpg://reader:pw@db.test/app")).toBeNull();
    expect(validateEnvironmentValue(dsn, "reader:pw@db.test")).toBe(
      "Enter a DSN like scheme://host",
    );
  });

  it.each(["30", "0.5", "-2", "+7", ".5", "1e3", "2.5E-3", " 42 "])(
    "accepts the number %s",
    (value) => {
      expect(validateEnvironmentValue(number, value)).toBeNull();
    },
  );

  it.each(["abc", "1,5", "0x10", "1_000", "Infinity", "NaN", "1e999", "--1"])(
    "rejects %s as a number",
    (value) => {
      expect(validateEnvironmentValue(number, value)).toBe("Enter a finite number like 30 or 0.5");
    },
  );

  it.each(["true", "false", "TRUE", " False "])("accepts the bool %s", (value) => {
    expect(validateEnvironmentValue(bool, value)).toBeNull();
  });

  it.each(["yes", "1", "on"])("rejects %s as a bool", (value) => {
    expect(validateEnvironmentValue(bool, value)).toBe("Choose true or false");
  });

  it("accepts any text for strings, tokens and passwords", () => {
    for (const kind of ["string", "token", "password"] as const) {
      expect(validateEnvironmentValue({ kind, secret: true }, " anything at all ")).toBeNull();
    }
  });

  it("rejects a value longer than the API accepts", () => {
    expect(
      validateEnvironmentValue({ kind: "string", secret: false }, "x".repeat(ENV_VALUE_MAX_LENGTH)),
    ).toBeNull();
    expect(
      validateEnvironmentValue(
        { kind: "string", secret: false },
        "x".repeat(ENV_VALUE_MAX_LENGTH + 1),
      ),
    ).toBe(`Use at most ${ENV_VALUE_MAX_LENGTH} characters`);
  });
});

describe("normalizeEnvironmentValue", () => {
  it("lowercases and trims bools, trims addresses and numbers, keeps the rest", () => {
    expect(normalizeEnvironmentValue("bool", " True ")).toBe("true");
    expect(normalizeEnvironmentValue("url", " https://a.test ")).toBe("https://a.test");
    expect(normalizeEnvironmentValue("dsn", " pg://h ")).toBe("pg://h");
    expect(normalizeEnvironmentValue("number", " 4 ")).toBe("4");
    expect(normalizeEnvironmentValue("token", " tok ")).toBe(" tok ");
    expect(normalizeEnvironmentValue("string", " a ")).toBe(" a ");
  });
});

describe("usesSwitch", () => {
  it("is true only for a plain bool", () => {
    expect(usesSwitch({ kind: "bool", secret: false })).toBe(true);
    expect(usesSwitch({ kind: "bool", secret: true })).toBe(false);
    expect(usesSwitch({ kind: "number", secret: false })).toBe(false);
  });
});

describe("createEnvironmentFormSchema", () => {
  const variables = [
    buildEnvironmentVariable({ name: "A_URL", kind: "url", secret: false }),
    buildEnvironmentVariable({ name: "A_LIMIT", kind: "number", secret: false, required: false }),
    buildEnvironmentVariable({ name: "A_TOKEN", kind: "token", secret: true, has_value: true }),
  ];
  const schema = createEnvironmentFormSchema(variables);

  function issues(values: Record<string, string>, clear: Record<string, boolean> = {}) {
    const defaults = defaultFormValues(variables);
    const result = schema.safeParse({
      values: { ...defaults.values, ...values },
      clear: { ...defaults.clear, ...clear },
    });
    return result.success
      ? []
      : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
  }

  it("passes untouched defaults", () => {
    expect(issues({})).toEqual([]);
  });

  it("reports a problem on the value path of the variable", () => {
    expect(issues({ A_URL: "nope", A_LIMIT: "x" })).toEqual([
      ["values.A_URL", "Enter a URL like scheme://host"],
      ["values.A_LIMIT", "Enter a finite number like 30 or 0.5"],
    ]);
  });

  it("does not validate an empty value or a cleared variable", () => {
    expect(issues({ A_URL: "   " })).toEqual([]);
    expect(issues({ A_LIMIT: "not a number" }, { A_LIMIT: true })).toEqual([]);
  });

  it("does not validate an untouched secret", () => {
    expect(issues({ A_TOKEN: "" })).toEqual([]);
    expect(issues({ A_TOKEN: "anything" })).toEqual([]);
  });
});

describe("constants", () => {
  it("keeps the health check timeout at 60 seconds", () => {
    expect(HEALTH_CHECK_TIMEOUT_MS).toBe(60_000);
  });
});
