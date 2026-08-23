import { describe, expect, it } from "vitest";
import { buildEnvironmentVariable } from "@/mocks/factories/environment";
import {
  buildEnvironmentPatch,
  countPatchChanges,
  defaultFormValues,
  isPatchEmpty,
} from "./build-patch";
import type { EnvironmentFormValues } from "./schemas";
import type { EnvironmentVariable } from "./types";

const API_URL = buildEnvironmentVariable({
  name: "APP_API_URL",
  kind: "url",
  secret: false,
  has_value: true,
  value: "https://app.qa.example.test",
});
const ADMIN_TOKEN = buildEnvironmentVariable({
  name: "APP_ADMIN_TOKEN",
  kind: "token",
  secret: true,
  has_value: true,
});
const UNSET_PASSWORD = buildEnvironmentVariable({
  name: "APP_GUEST_PASSWORD",
  kind: "password",
  secret: true,
  has_value: false,
});
const TIMEOUT = buildEnvironmentVariable({
  name: "APP_TIMEOUT_SECONDS",
  kind: "number",
  secret: false,
  required: false,
  has_value: true,
  value: "30",
});
const STRICT = buildEnvironmentVariable({
  name: "APP_STRICT",
  kind: "bool",
  secret: false,
  required: false,
  has_value: false,
});
const EMAIL = buildEnvironmentVariable({
  name: "APP_GUEST_EMAIL",
  kind: "string",
  secret: false,
  has_value: false,
});

const ALL: readonly EnvironmentVariable[] = [
  API_URL,
  ADMIN_TOKEN,
  UNSET_PASSWORD,
  TIMEOUT,
  STRICT,
  EMAIL,
];

function edit(
  variables: readonly EnvironmentVariable[],
  values: Record<string, string> = {},
  clear: string[] = [],
): EnvironmentFormValues {
  const base = defaultFormValues(variables);
  return {
    values: { ...base.values, ...values },
    clear: { ...base.clear, ...Object.fromEntries(clear.map((name) => [name, true])) },
  };
}

describe("defaultFormValues", () => {
  it("prefills plain values and never a secret", () => {
    const defaults = defaultFormValues(ALL);

    expect(defaults.values).toEqual({
      APP_API_URL: "https://app.qa.example.test",
      APP_ADMIN_TOKEN: "",
      APP_GUEST_PASSWORD: "",
      APP_TIMEOUT_SECONDS: "30",
      APP_STRICT: "",
      APP_GUEST_EMAIL: "",
    });
    expect(Object.values(defaults.clear).every((flag) => flag === false)).toBe(true);
  });

  it("does not prefill a secret even when the API sends its value", () => {
    const leaky = buildEnvironmentVariable({
      name: "APP_ADMIN_TOKEN",
      secret: true,
      has_value: true,
      value: "should-never-be-shown",
    });

    expect(defaultFormValues([leaky]).values.APP_ADMIN_TOKEN).toBe("");
  });
});

describe("buildEnvironmentPatch", () => {
  it("is empty when nothing was touched", () => {
    const patch = buildEnvironmentPatch(ALL, defaultFormValues(ALL));

    expect(patch).toEqual({ set: {}, clear: [] });
    expect(isPatchEmpty(patch)).toBe(true);
    expect(countPatchChanges(patch)).toBe(0);
  });

  it("omits an untouched secret and sends a typed one", () => {
    const untouched = buildEnvironmentPatch(ALL, edit(ALL, { APP_GUEST_PASSWORD: "hunter2" }));

    expect(untouched.set).toEqual({ APP_GUEST_PASSWORD: "hunter2" });
    expect(untouched.set).not.toHaveProperty("APP_ADMIN_TOKEN");
  });

  it("sends a replacement for a secret that already has a value", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, { APP_ADMIN_TOKEN: "new-token" }));

    expect(patch).toEqual({ set: { APP_ADMIN_TOKEN: "new-token" }, clear: [] });
  });

  it("does not trim a secret token or password", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, { APP_GUEST_PASSWORD: " pass phrase " }));

    expect(patch.set.APP_GUEST_PASSWORD).toBe(" pass phrase ");
  });

  it("sends a bool as the string true or false", () => {
    const on = buildEnvironmentPatch(ALL, edit(ALL, { APP_STRICT: "true" }));
    const off = buildEnvironmentPatch(ALL, edit(ALL, { APP_STRICT: "false" }));

    expect(on.set).toEqual({ APP_STRICT: "true" });
    expect(off.set).toEqual({ APP_STRICT: "false" });
    expect(typeof on.set.APP_STRICT).toBe("string");
  });

  it("sends a number as a string and ignores a value that did not change", () => {
    const changed = buildEnvironmentPatch(ALL, edit(ALL, { APP_TIMEOUT_SECONDS: " 45 " }));
    const same = buildEnvironmentPatch(ALL, edit(ALL, { APP_TIMEOUT_SECONDS: "30" }));

    expect(changed.set).toEqual({ APP_TIMEOUT_SECONDS: "45" });
    expect(typeof changed.set.APP_TIMEOUT_SECONDS).toBe("string");
    expect(same.set).toEqual({});
  });

  it("trims a URL and sends only the variables that changed", () => {
    const patch = buildEnvironmentPatch(
      ALL,
      edit(ALL, { APP_API_URL: "  https://other.qa.example.test  ", APP_GUEST_EMAIL: "qa@x.test" }),
    );

    expect(patch.set).toEqual({
      APP_API_URL: "https://other.qa.example.test",
      APP_GUEST_EMAIL: "qa@x.test",
    });
    expect(patch.clear).toEqual([]);
  });

  it("clears a stored secret only when Clear was pressed", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, {}, ["APP_ADMIN_TOKEN"]));

    expect(patch).toEqual({ set: {}, clear: ["APP_ADMIN_TOKEN"] });
  });

  it("clears a plain value when its field is emptied", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, { APP_API_URL: "  " }));

    expect(patch).toEqual({ set: {}, clear: ["APP_API_URL"] });
  });

  it("lets Clear win over anything typed and never sends the same name in both", () => {
    const patch = buildEnvironmentPatch(
      ALL,
      edit(ALL, { APP_ADMIN_TOKEN: "typed" }, ["APP_ADMIN_TOKEN"]),
    );

    expect(patch).toEqual({ set: {}, clear: ["APP_ADMIN_TOKEN"] });
  });

  it("ignores Clear on a variable that has no stored value", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, {}, ["APP_GUEST_PASSWORD", "APP_STRICT"]));

    expect(patch).toEqual({ set: {}, clear: [] });
  });

  it("does not clear a plain variable that never had a value", () => {
    const patch = buildEnvironmentPatch(ALL, edit(ALL, { APP_GUEST_EMAIL: "  " }));

    expect(patch).toEqual({ set: {}, clear: [] });
  });

  it("counts every set and clear", () => {
    const patch = buildEnvironmentPatch(
      ALL,
      edit(ALL, { APP_GUEST_PASSWORD: "x", APP_STRICT: "true" }, ["APP_ADMIN_TOKEN"]),
    );

    expect(countPatchChanges(patch)).toBe(3);
    expect(isPatchEmpty(patch)).toBe(false);
  });

  it("treats a stale variable like any other", () => {
    const stale = buildEnvironmentVariable({
      name: "OLD_KEY",
      kind: "token",
      secret: true,
      has_value: true,
      stale: true,
    });

    const patch = buildEnvironmentPatch([stale], edit([stale], {}, ["OLD_KEY"]));

    expect(patch.clear).toEqual(["OLD_KEY"]);
  });
});
