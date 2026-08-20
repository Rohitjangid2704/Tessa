import { useSearchParams } from "next/navigation";
import type { SearchParamsCodec } from "./search-params";

export type HistoryMode = "replace" | "push";

export interface UrlWriteOptions {
  history?: HistoryMode;
}

const NO_SEARCH_PARAMS = new URLSearchParams();

export function readLocationSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

export function buildLocationUrl(params: URLSearchParams): string {
  const search = params.toString();
  return `${window.location.pathname}${search === "" ? "" : `?${search}`}${window.location.hash}`;
}

export function writeLocationSearchParams(
  params: URLSearchParams,
  options: UrlWriteOptions = {},
): void {
  const url = buildLocationUrl(params);
  if (options.history === "push") {
    window.history.pushState(null, "", url);
    return;
  }
  window.history.replaceState(null, "", url);
}

export function mergeCodecParams<Values extends object>(
  current: URLSearchParams,
  codec: SearchParamsCodec<Values>,
  values: Partial<Values>,
): URLSearchParams {
  const merged = new URLSearchParams(current);
  for (const key of codec.keys) {
    merged.delete(key);
  }
  for (const [key, value] of codec.serialize(values)) {
    merged.append(key, value);
  }
  return merged;
}

export type FiltersPatch<Values> = Partial<Values> | ((previous: Values) => Partial<Values>);

export function useUrlFilters<Values extends object>(codec: SearchParamsCodec<Values>) {
  const searchParams = useSearchParams() ?? NO_SEARCH_PARAMS;
  const values = codec.parse(searchParams);
  const activeKeys = codec.activeKeys(values);

  function setFilters(patch: FiltersPatch<Values>, options: UrlWriteOptions = {}): void {
    const current = readLocationSearchParams();
    const previous = codec.parse(current);
    const resolved = typeof patch === "function" ? patch(previous) : patch;
    writeLocationSearchParams(
      mergeCodecParams(current, codec, { ...previous, ...resolved }),
      options,
    );
  }

  function resetFilters(options: UrlWriteOptions = {}): void {
    writeLocationSearchParams(mergeCodecParams(readLocationSearchParams(), codec, {}), options);
  }

  return { values, activeKeys, activeCount: activeKeys.length, setFilters, resetFilters };
}
