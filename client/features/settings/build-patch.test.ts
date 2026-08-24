import { describe, expect, it } from "vitest";
import type { SettingsRead } from "@/lib/api/types";
import { SettingsStore } from "@/mocks/stage4/settings-store";
import {
  buildSettingsPatch,
  collectChanges,
  countChangedLeaves,
  countPatchLeaves,
  describeSaved,
  isPatchEmpty,
  type SectionInput,
} from "./build-patch";
import { defaultSectionValues, leafId, type SettingsGroup } from "./schemas";

function settingsWith(
  leaves: ReadonlyArray<readonly [readonly string[], string | number]> = [],
): SettingsRead {
  const store = new SettingsStore();
  store.apply(leaves.map(([path, value]) => ({ path, value })));
  return store.read();
}

function edited(
  group: SettingsGroup,
  settings: SettingsRead,
  edits: Record<string, string> = {},
  resets: readonly string[] = [],
): SectionInput {
  const defaults = defaultSectionValues(group, settings);
  return {
    values: { ...defaults.values, ...edits },
    reset: { ...defaults.reset, ...Object.fromEntries(resets.map((id) => [id, true])) },
  };
}

describe("buildSettingsPatch", () => {
  it("sends an empty patch when nothing changed", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      models: edited("models", settings),
      thresholds: edited("thresholds", settings),
      endpoints: edited("endpoints", settings),
      budgets: edited("budgets", settings),
    });

    expect(patch).toEqual({});
    expect(isPatchEmpty(patch)).toBe(true);
  });

  it("sends only the leaves that changed, nested under their group", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      thresholds: edited("thresholds", settings, {
        [leafId("thresholds", "probe_confidence")]: "0.8",
      }),
    });

    expect(patch).toEqual({ thresholds: { probe_confidence: 0.8 } });
  });

  it("nests model leaves under the role and keeps the other roles out", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      models: edited("models", settings, {
        [leafId("models", "judge", "effort")]: "high",
        [leafId("models", "judge", "max_usd")]: "0.1",
        [leafId("models", "attack", "model")]: "  gpt-5.2-pro  ",
      }),
    });

    expect(patch).toEqual({
      models: {
        judge: { effort: "high", max_usd: 0.1 },
        attack: { model: "gpt-5.2-pro" },
      },
    });
    expect(countPatchLeaves(patch)).toBe(3);
  });

  it("sends numbers as numbers and integers as integers", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      budgets: edited("budgets", settings, {
        [leafId("budgets", "default_max_usd")]: "12.50",
        [leafId("budgets", "default_max_minutes")]: "45",
        [leafId("budgets", "max_concurrency")]: "8",
      }),
    });

    expect(patch).toEqual({
      budgets: { default_max_usd: 12.5, default_max_minutes: 45, max_concurrency: 8 },
    });
  });

  it("treats a number written differently but equal to the stored one as unchanged", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      thresholds: edited("thresholds", settings, {
        [leafId("thresholds", "probe_confidence")]: "0.750",
        [leafId("thresholds", "label_audit_rate")]: "0.05",
      }),
      budgets: edited("budgets", settings, { [leafId("budgets", "default_max_usd")]: "5.0" }),
    });

    expect(patch).toEqual({});
  });

  it("sends null for a leaf staged for reset, only where an override exists", () => {
    const settings = settingsWith([
      [["thresholds", "probe_confidence"], 0.8],
      [["models", "judge", "effort"], "high"],
    ]);

    const patch = buildSettingsPatch(settings, {
      thresholds: edited("thresholds", settings, {}, [
        leafId("thresholds", "probe_confidence"),
        leafId("thresholds", "label_audit_rate"),
      ]),
      models: edited("models", settings, {}, [leafId("models", "judge", "effort")]),
    });

    expect(patch).toEqual({
      thresholds: { probe_confidence: null },
      models: { judge: { effort: null } },
    });
  });

  it("ignores what was typed into a leaf staged for reset", () => {
    const settings = settingsWith([[["thresholds", "probe_confidence"], 0.8]]);

    const patch = buildSettingsPatch(settings, {
      thresholds: edited(
        "thresholds",
        settings,
        { [leafId("thresholds", "probe_confidence")]: "0.95" },
        [leafId("thresholds", "probe_confidence")],
      ),
    });

    expect(patch).toEqual({ thresholds: { probe_confidence: null } });
  });

  it("sets the Jev URL, removes it when emptied and leaves an unset one alone", () => {
    const unset = settingsWith();
    const jevId = leafId("endpoints", "jev_url");

    expect(
      buildSettingsPatch(unset, {
        endpoints: edited("endpoints", unset, { [jevId]: "https://jev.qa.example.test" }),
      }),
    ).toEqual({ endpoints: { jev_url: "https://jev.qa.example.test" } });
    expect(
      buildSettingsPatch(unset, { endpoints: edited("endpoints", unset, { [jevId]: "  " }) }),
    ).toEqual({});

    const configured = settingsWith([[["endpoints", "jev_url"], "https://jev.qa.example.test"]]);
    expect(
      buildSettingsPatch(configured, {
        endpoints: edited("endpoints", configured, { [jevId]: "" }),
      }),
    ).toEqual({ endpoints: { jev_url: null } });
  });

  it("keeps an invalid value out of the patch but still counts it as a change", () => {
    const settings = settingsWith();
    const input = edited("thresholds", settings, {
      [leafId("thresholds", "probe_confidence")]: "high",
      [leafId("thresholds", "label_audit_rate")]: "0.1",
    });

    expect(buildSettingsPatch(settings, { thresholds: input })).toEqual({
      thresholds: { label_audit_rate: 0.1 },
    });
    expect(countChangedLeaves(settings, "thresholds", input)).toBe(2);
    expect(collectChanges(settings, "thresholds", input).map((change) => change.kind)).toEqual([
      "invalid",
      "set",
    ]);
  });

  it("leaves a group out when no input is given for it", () => {
    const settings = settingsWith();

    const patch = buildSettingsPatch(settings, {
      budgets: edited("budgets", settings, { [leafId("budgets", "max_concurrency")]: "2" }),
    });

    expect(Object.keys(patch)).toEqual(["budgets"]);
  });
});

describe("describeSaved", () => {
  it("counts saved and reset leaves separately", () => {
    expect(describeSaved({ thresholds: { probe_confidence: 0.8 } })).toBe("1 setting saved.");
    expect(
      describeSaved({
        models: { judge: { effort: "high", max_usd: null } },
        thresholds: { probe_confidence: 0.9, label_audit_rate: null },
      }),
    ).toBe("2 settings saved, 2 settings reset to default.");
    expect(describeSaved({ endpoints: { jev_url: null } })).toBe("1 setting reset to default.");
  });
});
