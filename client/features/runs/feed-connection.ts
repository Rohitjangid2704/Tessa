import type { LiveState } from "@/components/status/status-types";
import type { EventStreamStatus } from "@/lib/sse/stream";

export interface FeedConnectionView {
  liveState: LiveState;
  label: string;
}

export function describeFeedConnection(status: EventStreamStatus): FeedConnectionView {
  switch (status) {
    case "live":
      return { liveState: "live", label: "Live" };
    case "connecting":
      return { liveState: "reconnecting", label: "Connecting" };
    case "reconnecting":
      return { liveState: "reconnecting", label: "Reconnecting" };
    case "failed":
      return { liveState: "error", label: "Offline" };
    case "idle":
    case "closed":
      return { liveState: "closed", label: "Not live" };
  }
}
