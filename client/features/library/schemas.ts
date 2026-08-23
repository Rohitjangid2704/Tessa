import { APP_KINDS } from "@/features/targets/app-kinds";
import { targetIdParam } from "@/features/targets/target-id-param";
import { createSearchParamsCodec, enumListParam, textParam } from "@/lib/search-params";

export const libraryFiltersCodec = createSearchParamsCodec({
  q: textParam(),
  app_kind: enumListParam(APP_KINDS),
  target_id: targetIdParam(),
});

export type LibraryFilterValues = ReturnType<typeof libraryFiltersCodec.parse>;
