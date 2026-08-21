import { describe, expect, it } from "vitest";
import {
  DARK_EDITOR_BACKGROUND,
  DARK_EDITOR_THEME,
  DARK_TOKEN_RULES,
  editorThemeName,
  LIGHT_EDITOR_BACKGROUND,
  LIGHT_EDITOR_THEME,
  LIGHT_TOKEN_RULES,
} from "./themes";

const MINIMUM_CONTRAST = 4.5;

function channel(hex: string, offset: number): number {
  const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 2) + 0.0722 * channel(hex, 4);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

describe("editor themes", () => {
  it.each([
    ["light", LIGHT_TOKEN_RULES, LIGHT_EDITOR_BACKGROUND],
    ["dark", DARK_TOKEN_RULES, DARK_EDITOR_BACKGROUND],
  ] as const)(
    "keep every %s token color above the AA contrast ratio",
    (_name, rules, background) => {
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule.foreground, rule.token).toBeDefined();
        expect(contrast(rule.foreground ?? "", background), rule.token).toBeGreaterThanOrEqual(
          MINIMUM_CONTRAST,
        );
      }
    },
  );

  it("picks the dark theme only for the dark resolved theme", () => {
    expect(editorThemeName("dark")).toBe(DARK_EDITOR_THEME);
    expect(editorThemeName("light")).toBe(LIGHT_EDITOR_THEME);
    expect(editorThemeName(undefined)).toBe(LIGHT_EDITOR_THEME);
  });
});
