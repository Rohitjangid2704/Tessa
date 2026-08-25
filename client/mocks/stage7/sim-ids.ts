import { stableId } from "../stage2/ids";

const HISTORY_RUN_ID = stableId("run_seed", "simulation_history");

export const SIMULATION_HISTORY_ATTEMPTS = 3;

export const SIMULATOR_IDS = {
  personas: {
    impatientGuest: stableId("persona", "impatient_guest"),
    meticulousManager: stableId("persona", "meticulous_manager"),
    firstTimer: stableId("persona", "first_timer"),
    billingAnalyst: stableId("persona", "billing_analyst"),
  },
  goals: {
    brokenAirConditioner: stableId("goal", "broken_air_conditioner"),
    checkoutTime: stableId("goal", "checkout_time"),
    otherGuestRequests: stableId("goal", "other_guest_requests"),
    seaViewUpgrade: stableId("goal", "sea_view_upgrade"),
    invoiceTotal: stableId("goal", "invoice_total"),
  },
  history: {
    runId: HISTORY_RUN_ID,
    sessionIds: Array.from({ length: SIMULATION_HISTORY_ATTEMPTS }, (_, attempt) =>
      stableId("sim_session", HISTORY_RUN_ID, attempt),
    ),
  },
} as const;
