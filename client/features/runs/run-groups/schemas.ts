import { z } from "zod";

export const RUN_GROUP_MIN_TARGETS = 2;
export const RUN_GROUP_MAX_TARGETS = 10;
export const RUN_GROUP_PLANS_LIMIT = 50;

export const runGroupSchema = z.object({
  plan_ids: z
    .array(z.uuid())
    .min(RUN_GROUP_MIN_TARGETS, `Pick at least ${RUN_GROUP_MIN_TARGETS} targets, one plan each`)
    .max(RUN_GROUP_MAX_TARGETS, `A group takes at most ${RUN_GROUP_MAX_TARGETS} targets`),
});

export type RunGroupFormValues = z.infer<typeof runGroupSchema>;
