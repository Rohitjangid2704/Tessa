import { stableId } from "../stage2/ids";

export const CONTRACT_IDS = {
  checks: {
    breaking: stableId("contract_check_seed", "gracie_hotel_ops"),
    compatible: stableId("contract_check_seed", "gracie_first_version_hotel_ops"),
  },
  runs: {
    breaking: stableId("seed_run", "contract_gracie_hotel_ops"),
    compatible: stableId("seed_run", "contract_gracie_first_version_hotel_ops"),
  },
} as const;

export const CONTRACT_SEED_TIMES = {
  breaking: "2026-10-05T10:00:00.000Z",
  compatible: "2026-10-04T09:00:00.000Z",
} as const;

export const CONTRACT_INTERFACE_IDS = {
  calendar: "hotel_ops.calendar",
  housekeeping: "hotel_ops.housekeeping",
  guests: "hotel_ops.guests",
  notifications: "hotel_ops.notifications",
  rooms: "hotel_ops.rooms",
} as const;
