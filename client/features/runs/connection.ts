import type { LiveState } from "@/components/status/status-types";
import type { RunStatus } from "@/lib/api/types";
import type { RunSocketStatus } from "@/lib/ws/socket";

export type ConnectionBanner = "none" | "reconnecting" | "resyncing" | "failed";

export interface ConnectionView {
  liveState: LiveState;
  label: string;
  banner: ConnectionBanner;
  announcement: string | null;
}

export interface ConnectionInput {
  status: RunSocketStatus;
  isTerminal: boolean;
}

export function describeConnection({ status, isTerminal }: ConnectionInput): ConnectionView {
  if (isTerminal) {
    return { liveState: "closed", label: "Not live", banner: "none", announcement: null };
  }
  switch (status) {
    case "live":
      return {
        liveState: "live",
        label: "Live",
        banner: "none",
        announcement: "Live updates connected",
      };
    case "connecting":
      return {
        liveState: "reconnecting",
        label: "Connecting",
        banner: "none",
        announcement: null,
      };
    case "reconnecting":
      return {
        liveState: "reconnecting",
        label: "Reconnecting",
        banner: "reconnecting",
        announcement: "Reconnecting to live updates",
      };
    case "resyncing":
      return {
        liveState: "reconnecting",
        label: "Resyncing",
        banner: "resyncing",
        announcement: "Reloading missed events",
      };
    case "failed":
      return {
        liveState: "error",
        label: "Offline",
        banner: "failed",
        announcement: "Live updates are unavailable",
      };
    case "idle":
    case "closed":
      return { liveState: "closed", label: "Closed", banner: "none", announcement: null };
  }
}

const RUN_STATUS_TEXT = {
  queued: "queued",
  planning: "planning",
  seeding: "seeding",
  running: "running",
  canceling: "canceling",
  completed: "completed",
  failed: "failed",
  canceled: "canceled",
  budget_exceeded: "stopped, budget exceeded",
} as const satisfies Record<RunStatus, string>;

export function describeRunAnnouncement(status: RunStatus, connection: ConnectionView): string {
  const runPart = `Run ${RUN_STATUS_TEXT[status]}`;
  return connection.announcement === null ? runPart : `${runPart}. ${connection.announcement}`;
}
