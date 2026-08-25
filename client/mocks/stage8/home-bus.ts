import type { EventEnvelope } from "../types";

export type HomeBusListener = (envelope: EventEnvelope) => void;

export class HomeBus {
  private readonly listeners = new Set<HomeBusListener>();

  subscribe(listener: HomeBusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(type: string, payload: object, runId: string | null = null): void {
    const envelope: EventEnvelope = {
      type,
      run_id: runId,
      seq: null,
      ts: new Date().toISOString(),
      payload,
    };
    for (const listener of [...this.listeners]) {
      listener(envelope);
    }
  }
}
