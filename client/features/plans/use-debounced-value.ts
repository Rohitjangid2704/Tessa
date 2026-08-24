import { useEffect, useState } from "react";

export function useDebouncedValue<Value>(
  value: Value,
  delayMs: number,
  isEqual: (left: Value, right: Value) => boolean = Object.is,
): Value {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (isEqual(value, debounced)) {
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs, isEqual]);

  return debounced;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
