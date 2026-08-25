import { stableId } from "../stage2/ids";

export const RUN_GROUP_IDS = {
  groups: {
    completed: stableId("run_group", "completed"),
    failed: stableId("run_group", "failed"),
  },
  plans: {
    billing: stableId("seed_plan_stage9", "billing"),
    liveShop: stableId("seed_plan_stage9", "live_shop"),
  },
  runs: {
    completed: {
      gracie: stableId("run_group_seed", "completed", "gracie"),
      billing: stableId("run_group_seed", "completed", "billing"),
      liveShop: stableId("run_group_seed", "completed", "live_shop"),
    },
    failed: {
      gracie: stableId("run_group_seed", "failed", "gracie"),
      billing: stableId("run_group_seed", "failed", "billing"),
    },
  },
} as const;
