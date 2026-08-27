export function asList<Value>(value: Value | Value[] | undefined): Value[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value : [value];
}
