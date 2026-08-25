import { RunContext } from "../server/run-simulator";
import type { ScriptContext } from "../simulation/script";

export function stampOf(context: ScriptContext): string {
  return context instanceof RunContext ? context.timestamp() : new Date().toISOString();
}

export function emitRaw(context: ScriptContext, type: string, payload: object): void {
  if (context instanceof RunContext && context.mode.kind === "instant") {
    context.record.events.push({
      type,
      run_id: context.record.id,
      seq: context.record.events.length + 1,
      ts: context.timestamp(),
      payload: { ...payload },
    });
    return;
  }
  context.state.appendRawEvent(context.record, type, payload);
}

export function isInstant(context: ScriptContext): boolean {
  return context instanceof RunContext && context.mode.kind === "instant";
}
