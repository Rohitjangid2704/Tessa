import { describe, expect, it } from "vitest";
import { SettingsStore } from "@/mocks/stage4/settings-store";
import {
  createSectionSchema,
  defaultSectionValues,
  findLeafSpec,
  isOverridden,
  leafId,
  leafSpecs,
  sectionRevision,
  storedLeaf,
  validateLeaf,
  validateSecretInput,
} from "./schemas";

describe("leaf specs", () => {
  it("lists four leaves for each of the seven roles and the flat groups", () => {
    expect(leafSpecs("models")).toHaveLength(28);
    expect(leafSpecs("thresholds").map((spec) => spec.dotted)).toEqual([
      "thresholds.probe_confidence",
      "thresholds.judge_escalate_below",
      "thresholds.label_audit_rate",
    ]);
    expect(leafSpecs("endpoints").map((spec) => spec.dotted)).toEqual([
      "endpoints.laya_url",
      "endpoints.jev_url",
    ]);
    expect(leafSpecs("budgets").map((spec) => spec.dotted)).toEqual([
      "budgets.default_max_usd",
      "budgets.default_max_minutes",
      "budgets.max_concurrency",
    ]);
  });

  it("uses dotted paths that match the override paths and form keys without dots", () => {
    const spec = findLeafSpec("models", "judge_tiebreak", "timeout_seconds");

    expect(spec.dotted).toBe("models.judge_tiebreak.timeout_seconds");
    expect(spec.id).toBe("models__judge_tiebreak__timeout_seconds");
    expect(spec.id).not.toContain(".");
    expect(spec.label).toBe("Judge tie-break timeout in seconds");
    expect(leafId("endpoints", "jev_url")).toBe("endpoints__jev_url");
  });

  it("throws for a leaf that does not exist", () => {
    expect(() => findLeafSpec("models", "judge", "colour")).toThrow("Unknown settings leaf");
  });
});

describe("stored values", () => {
  const store = new SettingsStore();
  store.apply([
    { path: ["models", "judge", "effort"], value: "high" },
    { path: ["endpoints", "jev_url"], value: "https://jev.qa.example.test" },
  ]);
  const settings = store.read();

  it("reads a leaf, an unset nullable leaf and the override flag", () => {
    expect(storedLeaf(settings, findLeafSpec("models", "judge", "effort"))).toBe("high");
    expect(storedLeaf(settings, findLeafSpec("models", "judge", "max_usd"))).toBe(0.05);
    expect(storedLeaf(settings, findLeafSpec("thresholds", "probe_confidence"))).toBe(0.75);
    expect(isOverridden(settings, findLeafSpec("models", "judge", "effort"))).toBe(true);
    expect(isOverridden(settings, findLeafSpec("models", "judge", "model"))).toBe(false);

    const unset = new SettingsStore().read();
    expect(storedLeaf(unset, findLeafSpec("endpoints", "jev_url"))).toBeNull();
    expect(defaultSectionValues("endpoints", unset).values[leafId("endpoints", "jev_url")]).toBe(
      "",
    );
  });

  it("builds string form values and an all-false reset map", () => {
    const defaults = defaultSectionValues("budgets", settings);

    expect(defaults.values).toEqual({
      budgets__default_max_usd: "5",
      budgets__default_max_minutes: "30",
      budgets__max_concurrency: "4",
    });
    expect(Object.values(defaults.reset)).toEqual([false, false, false]);
  });

  it("changes the section revision when a value or its source changes", () => {
    const before = sectionRevision("thresholds", settings);
    const next = new SettingsStore();
    next.apply([{ path: ["thresholds", "probe_confidence"], value: 0.75 }]);

    expect(sectionRevision("thresholds", next.read())).not.toBe(before);
    expect(sectionRevision("budgets", next.read())).toBe(sectionRevision("budgets", settings));
  });
});

describe("validateLeaf", () => {
  it.each([
    ["model", "gpt-5.2", null],
    ["model", "  ", "Enter a model name"],
    ["model", "x".repeat(201), "Use at most 200 characters"],
    ["effort", "high", null],
    ["effort", "ultra", "Choose an effort"],
    ["positive-number", "0.05", null],
    ["positive-number", "0", "Enter a number greater than 0"],
    ["positive-number", "-1", "Enter a number greater than 0"],
    ["positive-number", "1e3", "Enter a number greater than 0"],
    ["positive-number", "", "Enter a number greater than 0"],
    ["positive-integer", "30", null],
    ["positive-integer", "2.5", "Enter a whole number of at least 1"],
    ["positive-integer", "0", "Enter a whole number of at least 1"],
    ["unit-interval", "0", null],
    ["unit-interval", "1", null],
    ["unit-interval", "0.75", null],
    ["unit-interval", "1.01", "Enter a number from 0 to 1"],
    ["unit-interval", "-0.1", "Enter a number from 0 to 1"],
    ["unit-interval", "abc", "Enter a number from 0 to 1"],
    ["url", "http://127.0.0.1:7006", null],
    ["url", "https://laya.example.test/path", null],
    ["url", "laya", "Enter a URL like http://host:port"],
    ["url", "ftp://laya.example.test", "Enter a URL like http://host:port"],
    ["url", "", "Enter a URL like http://host:port"],
    ["optional-url", "", null],
    ["optional-url", "https://jev.example.test", null],
    ["optional-url", "jev", "Enter a URL like https://host, or leave it empty"],
  ] as const)("%s of %j gives %j", (kind, typed, expected) => {
    expect(validateLeaf(kind, typed)).toBe(expected);
  });
});

describe("createSectionSchema", () => {
  const settings = new SettingsStore().read();

  it("accepts the stored values", () => {
    const form = defaultSectionValues("thresholds", settings);

    expect(createSectionSchema("thresholds").safeParse(form).success).toBe(true);
    expect(
      createSectionSchema("models").safeParse(defaultSectionValues("models", settings)).success,
    ).toBe(true);
  });

  it("reports each invalid leaf under values and its leaf id", () => {
    const form = defaultSectionValues("thresholds", settings);
    form.values[leafId("thresholds", "probe_confidence")] = "2";
    form.values[leafId("thresholds", "label_audit_rate")] = "lots";

    const result = createSectionSchema("thresholds").safeParse(form);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
      ["values.thresholds__probe_confidence", "Enter a number from 0 to 1"],
      ["values.thresholds__label_audit_rate", "Enter a number from 0 to 1"],
    ]);
  });

  it("does not validate a leaf staged for reset", () => {
    const form = defaultSectionValues("budgets", settings);
    form.values[leafId("budgets", "max_concurrency")] = "";
    form.reset[leafId("budgets", "max_concurrency")] = true;

    expect(createSectionSchema("budgets").safeParse(form).success).toBe(true);
  });
});

describe("validateSecretInput", () => {
  it("needs a value of a sane length and an https URL for the Slack webhook", () => {
    expect(validateSecretInput("openai_api_key", "sk-dev-only-0001")).toBeNull();
    expect(validateSecretInput("openai_api_key", "")).toBe("Enter the key");
    expect(validateSecretInput("openai_api_key", "x".repeat(4097))).toBe(
      "Use at most 4096 characters",
    );
    expect(validateSecretInput("slack_webhook_url", "http://hooks.example.test/x")).toBe(
      "A Slack webhook is an https URL",
    );
    expect(validateSecretInput("slack_webhook_url", "https://hooks.example.test/x")).toBeNull();
  });
});
