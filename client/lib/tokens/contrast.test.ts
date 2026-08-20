import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  isInSrgbGamut,
  parseOklch,
  parseTokenBlock,
  type Oklch,
  type TokenBlock,
} from "./contrast";

const MINIMUM_CONTRAST = 4.5;

const stylesheet = readFileSync(path.resolve(import.meta.dirname, "../../app/globals.css"), "utf8");

const themes: Record<"light" | "dark", TokenBlock> = {
  light: parseTokenBlock(stylesheet, ":root"),
  dark: parseTokenBlock(stylesheet, ".dark"),
};

const SEMANTIC_FAMILIES: Record<string, string[]> = {
  verdict: ["pass", "fail", "flaky", "uncertain", "skipped"],
  severity: ["critical", "high", "medium", "low", "info"],
  tier: ["code", "laya", "judge", "human"],
  live: ["live", "reconnecting", "closed", "error"],
};

type Pair = { foreground: string; background: string };

function colorTokens(tokens: TokenBlock): TokenBlock {
  return Object.fromEntries(
    Object.entries(tokens).filter(([, value]) => value.startsWith("oklch(")),
  );
}

function color(tokens: TokenBlock, name: string): Oklch {
  const value = tokens[name];
  if (value === undefined) {
    throw new Error(`Missing token --${name}`);
  }
  return parseOklch(value);
}

function surfaceColors(tokens: TokenBlock): Pair["background"][] {
  return ["background", "card"].filter((name) => name in tokens);
}

function foregroundPairs(tokens: TokenBlock): Pair[] {
  const pairs: Pair[] = [{ foreground: "foreground", background: "background" }];
  for (const name of Object.keys(tokens)) {
    if (name.endsWith("-solid-fg")) {
      pairs.push({ foreground: name, background: name.slice(0, -"-fg".length) });
    } else if (name.endsWith("-fg")) {
      const base = name.slice(0, -"-fg".length);
      pairs.push({ foreground: name, background: `${base}-bg` });
      for (const surface of surfaceColors(tokens)) {
        pairs.push({ foreground: name, background: surface });
      }
    } else if (name.endsWith("-foreground")) {
      const base = name.slice(0, -"-foreground".length);
      if (base in tokens) {
        pairs.push({ foreground: name, background: base });
      }
    }
  }
  for (const surface of surfaceColors(tokens)) {
    pairs.push({ foreground: "muted-foreground", background: surface });
    pairs.push({ foreground: "destructive", background: surface });
  }
  return pairs;
}

describe.each(["light", "dark"] as const)("globals.css tokens (%s)", (theme) => {
  const tokens = colorTokens(themes[theme]);

  it.each(foregroundPairs(tokens))(
    "--$foreground on --$background is at least 4.5:1",
    ({ foreground, background }) => {
      const ratio = contrastRatio(color(tokens, foreground), color(tokens, background));
      expect(ratio).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
    },
  );

  it("keeps destructive text readable on the tinted destructive button background", () => {
    const tintAlpha = theme === "light" ? 0.1 : 0.2;
    const destructive = color(tokens, "destructive");
    const tint = compositeOver({ ...destructive, alpha: tintAlpha }, color(tokens, "background"));
    expect(contrastRatio(destructive, tint)).toBeGreaterThanOrEqual(MINIMUM_CONTRAST);
  });

  it("keeps every color token inside the sRGB gamut", () => {
    const outOfGamut = Object.entries(tokens)
      .filter(([, value]) => !isInSrgbGamut(parseOklch(value)))
      .map(([name]) => name);
    expect(outOfGamut).toEqual([]);
  });

  it("defines every semantic family member with a background and a foreground", () => {
    const missing = Object.entries(SEMANTIC_FAMILIES).flatMap(([family, members]) =>
      members.flatMap((member) =>
        [`${family}-${member}-bg`, `${family}-${member}-fg`].filter((name) => !(name in tokens)),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("defines the solid critical severity", () => {
    expect(tokens["severity-critical-solid"]).toBeDefined();
    expect(tokens["severity-critical-solid-fg"]).toBeDefined();
  });
});

describe("globals.css theme parity", () => {
  it("defines the same color tokens in light and dark", () => {
    expect(Object.keys(colorTokens(themes.dark)).sort()).toEqual(
      Object.keys(colorTokens(themes.light)).sort(),
    );
  });

  it("maps every semantic token into the Tailwind theme", () => {
    const unmapped = Object.keys(colorTokens(themes.light)).filter(
      (name) => !stylesheet.includes(`--color-${name}: var(--${name});`),
    );
    expect(unmapped).toEqual([]);
  });
});

describe("contrast helpers", () => {
  it("reports 21:1 for black on white", () => {
    expect(
      contrastRatio(
        { lightness: 0, chroma: 0, hue: 0, alpha: 1 },
        { lightness: 1, chroma: 0, hue: 0, alpha: 1 },
      ),
    ).toBeCloseTo(21, 0);
  });

  it("parses alpha and percentages", () => {
    expect(parseOklch("oklch(1 0 0 / 10%)")).toEqual({
      lightness: 1,
      chroma: 0,
      hue: 0,
      alpha: 0.1,
    });
  });
});
