import type { LiveState } from "@/components/status/status-types";
import type { RunSocketStatus } from "@/lib/ws/socket";

export function toLiveState(status: RunSocketStatus): LiveState {
  switch (status) {
    case "live":
      return "live";
    case "connecting":
    case "reconnecting":
    case "resyncing":
      return "reconnecting";
    case "failed":
      return "error";
    case "idle":
    case "closed":
      return "closed";
  }
}
