import { z } from "zod";
import {
  booleanParam,
  createSearchParamsCodec,
  enumListParam,
  sortParam,
  textParam,
} from "@/lib/search-params";
import { APP_KINDS, TARGET_TIERS } from "./app-kinds";

export const TARGET_NAME_MAX_LENGTH = 120;
export const TARGET_SORT_KEYS = ["name", "created_at"] as const;
export const DEFAULT_TARGET_SORT = "-created_at";

export const targetNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(TARGET_NAME_MAX_LENGTH, `Use at most ${TARGET_NAME_MAX_LENGTH} characters`);

export const targetCreateSchema = z.object({
  name: targetNameSchema,
  app_kind: z.enum(APP_KINDS, { error: "Choose an app kind" }),
});

export type TargetCreateInput = z.infer<typeof targetCreateSchema>;

export const targetRenameSchema = z.object({ name: targetNameSchema });

export type TargetRenameInput = z.infer<typeof targetRenameSchema>;

export const targetFiltersCodec = createSearchParamsCodec(
  {
    q: textParam(),
    app_kind: enumListParam(APP_KINDS),
    tier: enumListParam(TARGET_TIERS),
    include_archived: booleanParam(),
    sort: sortParam(TARGET_SORT_KEYS),
  },
  { defaults: { include_archived: false, sort: DEFAULT_TARGET_SORT } },
);

export type TargetFilterValues = ReturnType<typeof targetFiltersCodec.parse>;
