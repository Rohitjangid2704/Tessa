"use client";

import { LiveIndicator } from "@/components/status/live-indicator";
import { describeConnection } from "../connection";
import { useRunStreamState } from "../use-run-stream";

export function RunLiveIndicator() {
  const { status, isTerminal } = useRunStreamState();
  const connection = describeConnection({ status, isTerminal });
  return <LiveIndicator role={undefined} state={connection.liveState} label={connection.label} />;
}
