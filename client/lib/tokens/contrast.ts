export type Oklch = { lightness: number; chroma: number; hue: number; alpha: number };
export type Rgb = { red: number; green: number; blue: number };

const OKLCH_PATTERN =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/;

export function parseOklch(value: string): Oklch {
  const match = OKLCH_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported color value: ${value}`);
  }
  const [, lightness, lightnessPercent, chroma, hue, alpha, alphaPercent] = match;
  const alphaValue = alpha === undefined ? 1 : Number(alpha) / (alphaPercent ? 100 : 1);
  return {
    lightness: Number(lightness) / (lightnessPercent ? 100 : 1),
    chroma: Number(chroma),
    hue: Number(hue),
    alpha: alphaValue,
  };
}

export function oklchToLinearSrgb({ lightness, chroma, hue }: Oklch): Rgb {
  const hueRadians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(hueRadians);
  const b = chroma * Math.sin(hueRadians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    red: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    green: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    blue: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

const GAMUT_TOLERANCE = 0.002;

export function isInSrgbGamut(color: Oklch): boolean {
  const { red, green, blue } = oklchToLinearSrgb(color);
  return [red, green, blue].every(
    (channel) => channel >= -GAMUT_TOLERANCE && channel <= 1 + GAMUT_TOLERANCE,
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function encodeGamma(linear: number): number {
  const clamped = clamp01(linear);
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function decodeGamma(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

export function toEightBitSrgb(color: Oklch): Rgb {
  const linear = oklchToLinearSrgb(color);
  return {
    red: Math.round(encodeGamma(linear.red) * 255),
    green: Math.round(encodeGamma(linear.green) * 255),
    blue: Math.round(encodeGamma(linear.blue) * 255),
  };
}

export function compositeOver(foreground: Oklch, background: Oklch): Oklch {
  if (foreground.alpha >= 1) {
    return foreground;
  }
  const top = oklchToLinearSrgb(foreground);
  const bottom = oklchToLinearSrgb(background);
  const mix = (front: number, back: number) =>
    decodeGamma(encodeGamma(front) * foreground.alpha + encodeGamma(back) * (1 - foreground.alpha));
  const mixed = {
    red: mix(top.red, bottom.red),
    green: mix(top.green, bottom.green),
    blue: mix(top.blue, bottom.blue),
  };
  return linearSrgbToOklch(mixed);
}

function linearSrgbToOklch({ red, green, blue }: Rgb): Oklch {
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { lightness, chroma: Math.hypot(a, b), hue, alpha: 1 };
}

export function relativeLuminance(color: Oklch): number {
  const { red, green, blue } = toEightBitSrgb(color);
  return (
    0.2126 * decodeGamma(red / 255) +
    0.7152 * decodeGamma(green / 255) +
    0.0722 * decodeGamma(blue / 255)
  );
}

export function contrastRatio(foreground: Oklch, background: Oklch): number {
  const front = relativeLuminance(compositeOver(foreground, background));
  const back = relativeLuminance(background);
  const lighter = Math.max(front, back);
  const darker = Math.min(front, back);
  return (lighter + 0.05) / (darker + 0.05);
}

export type TokenBlock = Record<string, string>;

export function parseTokenBlock(css: string, selector: string): TokenBlock {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`Selector ${selector} not found`);
  }
  const end = css.indexOf("}", start);
  const body = css.slice(start + selector.length + 2, end);
  const tokens: TokenBlock = {};
  for (const line of body.split(";")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    if (name.startsWith("--")) {
      tokens[name.slice(2)] = line.slice(separator + 1).trim();
    }
  }
  return tokens;
}
