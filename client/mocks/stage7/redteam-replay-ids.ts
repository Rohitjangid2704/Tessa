import { stableId } from "../stage2/ids";

export const REDTEAM_REPLAY_IDS = {
  runs: {
    redteam: stableId("seed_run", "redteam_completed"),
    replayTraffic: stableId("seed_run", "replay_traffic"),
    replayPartner: stableId("seed_run", "replay_partner"),
  },
  replays: {
    traffic: stableId("replay", "traffic-2026-09-30"),
    partner: stableId("replay", "partner-chat-export"),
  },
} as const;

export const REPLAY_SEED_TIMES = {
  redteam: "2026-10-04T12:00:00.000Z",
  replayPartner: "2026-10-03T16:00:00.000Z",
  replayTraffic: "2026-10-04T14:00:00.000Z",
} as const;
