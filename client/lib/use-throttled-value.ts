import { useEffect, useRef, useState } from "react";

export function useThrottledValue<Value>(value: Value, intervalMs: number): Value {
  const [shown, setShown] = useState(value);
  const lastShownAt = useRef(0);

  useEffect(() => {
    if (Object.is(value, shown)) {
      return;
    }
    const wait = Math.max(0, lastShownAt.current + intervalMs - Date.now());
    const timer = setTimeout(() => {
      lastShownAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, shown, intervalMs]);

  return shown;
}
