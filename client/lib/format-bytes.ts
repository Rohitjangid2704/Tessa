const UNITS = ["B", "KiB", "MiB", "GiB"] as const;
const STEP = 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown size";
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= STEP && unitIndex < UNITS.length - 1) {
    value /= STEP;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unitIndex]}`;
}
