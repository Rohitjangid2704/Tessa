"use client";

import { useEffect, useEffectEvent, useRef, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import type { FrameBus, PaintedFrame, TileMode } from "./frame-bus";

export const SCREENCAST_DEFAULT_WIDTH = 640;
export const SCREENCAST_DEFAULT_HEIGHT = 400;
export const SCREENCAST_VISIBILITY_THRESHOLD = 0.1;

export type ScreencastCanvasProps = {
  bus: FrameBus;
  sessionId: string;
  mode?: TileMode;
  paused?: boolean;
  onFrame?: (frame: PaintedFrame) => void;
  label: string;
} & Omit<ComponentProps<"canvas">, "ref" | "children" | "role" | "aria-label">;

export function ScreencastCanvas({
  bus,
  sessionId,
  mode = "grid",
  paused = false,
  onFrame,
  label,
  className,
  ...props
}: ScreencastCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reportFrame = useEffectEvent((frame: PaintedFrame) => {
    onFrame?.(frame);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext("2d", { alpha: false });
    return bus.attach(sessionId, {
      paint: (image, frame) => {
        if (canvas.width !== frame.width || canvas.height !== frame.height) {
          canvas.width = frame.width;
          canvas.height = frame.height;
        }
        context?.drawImage(image, 0, 0);
        reportFrame(frame);
      },
    });
  }, [bus, sessionId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    if (paused) {
      bus.setTileVisible(sessionId, false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          bus.setTileVisible(sessionId, entry.isIntersecting);
        }
      },
      { threshold: SCREENCAST_VISIBILITY_THRESHOLD },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [bus, sessionId, paused]);

  useEffect(() => {
    bus.setTileMode(sessionId, mode);
  }, [bus, sessionId, mode]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={label}
      data-slot="screencast-canvas"
      data-session-id={sessionId}
      data-paused={paused ? "true" : undefined}
      width={SCREENCAST_DEFAULT_WIDTH}
      height={SCREENCAST_DEFAULT_HEIGHT}
      className={cn("block h-auto w-full bg-muted", className)}
      {...props}
    />
  );
}
