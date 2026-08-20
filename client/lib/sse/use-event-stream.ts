import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { KnownStreamEvent } from "@/features/streams/events";
import { apiBaseUrl, authedFetch } from "@/lib/api/client";
import {
  EventStream,
  buildFeedUrl,
  createInitialEventStreamState,
  type EventStreamFetch,
  type EventStreamState,
  type FeedQuery,
  type HelloContext,
} from "./stream";

export interface UseEventStreamOptions {
  enabled?: boolean;
  query?: FeedQuery;
  onEvent?: (event: KnownStreamEvent) => void;
  onHello?: (event: KnownStreamEvent, context: HelloContext) => void;
  fetch?: EventStreamFetch;
  baseUrl?: string;
  silenceTimeoutMs?: number;
  random?: () => number;
}

const idleState = createInitialEventStreamState();

const subscribeToNothing = (): (() => void) => () => {};

const readIdleState = (): EventStreamState => idleState;

function createStream(url: string | null, options: UseEventStreamOptions): EventStream | null {
  if (url === null) {
    return null;
  }
  return new EventStream({
    url,
    fetch: options.fetch ?? authedFetch,
    random: options.random,
    silenceTimeoutMs: options.silenceTimeoutMs,
  });
}

export function useEventStream(
  path: string | null,
  options: UseEventStreamOptions = {},
): EventStreamState {
  const { enabled = true, onEvent, onHello } = options;
  const url =
    path === null ? null : buildFeedUrl(path, options.baseUrl ?? apiBaseUrl, options.query);
  const [stored, setStored] = useState(() => createStream(url, options));

  let stream = stored;
  if ((stream?.url ?? null) !== url) {
    stream = createStream(url, options);
    setStored(stream);
  }

  const handleEvent = useEffectEvent((event: KnownStreamEvent) => {
    onEvent?.(event);
  });
  const handleHello = useEffectEvent((event: KnownStreamEvent, context: HelloContext) => {
    onHello?.(event, context);
  });

  useEffect(() => {
    if (stream === null || !enabled) {
      return;
    }
    stream.setListeners({
      onEvent: (event) => handleEvent(event),
      onHello: (event, context) => handleHello(event, context),
    });
    stream.connect();
    return () => stream.close();
  }, [stream, enabled]);

  return useSyncExternalStore(
    stream?.subscribe ?? subscribeToNothing,
    stream?.getState ?? readIdleState,
    stream?.getState ?? readIdleState,
  );
}
