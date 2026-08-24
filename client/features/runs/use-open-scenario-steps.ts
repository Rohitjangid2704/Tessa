import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeApiError } from "@/lib/api/errors";
import type { RunScenario, StepSummary } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { runScenarioQuery } from "./queries";
import type { TileSession } from "./tile-sessions";

export const RUN_SCENARIO_STALE_MS = 5000;

export const NO_STEPS_MESSAGE = "This scenario has no recorded steps yet.";

export interface OpenStepsError {
  sessionId: string;
  message: string;
}

export interface OpenScenarioSteps {
  pendingSessionId: string | null;
  error: OpenStepsError | null;
  open: (session: TileSession) => Promise<void>;
}

export function firstStepOfAttempt(
  scenario: Pick<RunScenario, "steps">,
  attempt: number,
): StepSummary | undefined {
  const ordered = [...scenario.steps].sort(
    (left, right) => left.attempt - right.attempt || left.index - right.index,
  );
  return ordered.find((step) => step.attempt === attempt) ?? ordered[0];
}

export function useOpenScenarioSteps(runId: string): OpenScenarioSteps {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<OpenStepsError | null>(null);

  async function open(session: TileSession): Promise<void> {
    setPendingSessionId(session.id);
    setError(null);
    try {
      const scenario = await queryClient.fetchQuery({
        ...runScenarioQuery(session.runScenarioId),
        staleTime: RUN_SCENARIO_STALE_MS,
      });
      const step = firstStepOfAttempt(scenario, session.attempt);
      if (step === undefined) {
        setError({ sessionId: session.id, message: NO_STEPS_MESSAGE });
      } else {
        router.push(runRoutes.step(runId, step.id));
      }
    } catch (failure) {
      setError({ sessionId: session.id, message: describeApiError(failure) });
    } finally {
      setPendingSessionId(null);
    }
  }

  return { pendingSessionId, error, open };
}
