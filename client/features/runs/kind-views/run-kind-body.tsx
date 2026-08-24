"use client";

import { DEFAULT_RUN_BODY_KIND } from "../components/run-body";
import { useRunStreamState } from "../use-run-stream";
import { FALLBACK_RUN_KIND_VIEW, RUN_KIND_VIEWS } from "./registry";

export type RunKindBodyProps = { runId: string };

export function RunKindBody({ runId }: RunKindBodyProps) {
  const { run } = useRunStreamState();
  const kind = run?.kind ?? DEFAULT_RUN_BODY_KIND;
  const View = RUN_KIND_VIEWS[kind] ?? FALLBACK_RUN_KIND_VIEW;
  return <View key={kind} runId={runId} />;
}
