"use client";

import { RunBody } from "../components/run-body";

export type SuiteViewProps = { runId: string };

export function SuiteView({ runId }: SuiteViewProps) {
  return <RunBody runId={runId} />;
}
