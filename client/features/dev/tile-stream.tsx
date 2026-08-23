"use client";

import { useEffect, useState } from "react";
import { LiveIndicator } from "@/components/status/live-indicator";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { KnownStreamEvent } from "@/features/streams/events";
import { toLiveState } from "@/features/streams/live-state";
import { createListStore, useStore } from "@/lib/store";
import { useFrameBus, useFrameBusStats, useFrameBusTransport } from "@/lib/ws/frame-bus";
import { ScreencastCanvas } from "@/lib/ws/screencast-canvas";
import { useRunSocket } from "@/lib/ws/use-run-socket";
import { PerformanceMonitor } from "./performance-monitor";
import { TileHud } from "./tile-hud";

interface TileSession {
  id: string;
  title: string;
}

function isSessionStarted(
  event: KnownStreamEvent,
): event is Extract<KnownStreamEvent, { type: "browser_session.started" }> {
  return event.type === "browser_session.started";
}

export function TileStream({ runId }: { runId: string }) {
  const bus = useFrameBus();
  const [monitor] = useState(() => new PerformanceMonitor());
  const [sessions] = useState(() => createListStore<TileSession>());
  const tiles = useStore(sessions);
  const busStats = useFrameBusStats(bus);
  const performance = useStore(monitor);

  useEffect(() => {
    monitor.start();
    return () => monitor.stop();
  }, [monitor]);

  const socket = useRunSocket(runId, {
    onEvent: (event) => {
      if (event.type === "tile.frame") {
        bus.publish(event.payload);
        return;
      }
      if (isSessionStarted(event)) {
        sessions.append({
          id: event.payload.browser_session_id,
          title: event.payload.scenario_title,
        });
      }
    },
    onMessageHandled: (sample) => bus.recordHandlerSample(sample.durationMs),
  });

  useFrameBusTransport(
    bus,
    socket.send,
    socket.status === "live" && socket.replayComplete,
    socket.limits?.max_tiles,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <LiveIndicator state={toLiveState(socket.status)} />
        <span>
          {tiles.length} sessions, last seq {socket.lastSeq}
        </span>
        {socket.message ? <span className="text-muted-foreground">{socket.message}</span> : null}
        <Button
          type="button"
          variant="link"
          size="xs"
          className="ml-auto"
          onClick={() => {
            bus.resetStats();
            monitor.reset();
          }}
        >
          Reset counters
        </Button>
      </div>
      <TileHud bus={busStats} performance={performance} />
      <ul
        aria-label="Browser session tiles"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4"
      >
        {tiles.map((tile, index) => (
          <li key={tile.id}>
            <Card className="gap-0 overflow-hidden p-0">
              <ScreencastCanvas
                bus={bus}
                sessionId={tile.id}
                label={`Live view of ${tile.title}`}
              />
              <p className="truncate px-2 py-1 text-xs text-muted-foreground">
                {index + 1}. {tile.title}
              </p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
