const PERCENT = 100;

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(Math.min(1, Math.max(0, value)) * PERCENT)}%`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const magnitude = Math.abs(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  if (value === 0) {
    return magnitude;
  }
  return `${value > 0 ? "+" : "-"}${magnitude}`;
}

export function formatSignedMilliseconds(value: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0 ms";
  }
  const sign = rounded > 0 ? "+" : "-";
  const magnitude = Math.abs(rounded);
  return magnitude >= 1000
    ? `${sign}${(magnitude / 1000).toFixed(1)} s`
    : `${sign}${magnitude} ms`;
}
