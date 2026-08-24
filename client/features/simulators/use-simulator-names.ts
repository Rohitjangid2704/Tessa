import { useQuery } from "@tanstack/react-query";
import { goalOptionsQuery, personaOptionsQuery } from "./queries";

export interface SimulatorNames {
  personaName: (personaId: string) => string | null;
  goalTitle: (goalId: string) => string | null;
  isLoading: boolean;
}

export function useSimulatorNames(targetId: string | null): SimulatorNames {
  const enabled = targetId !== null;
  const personas = useQuery({ ...personaOptionsQuery(targetId ?? ""), enabled });
  const goals = useQuery({ ...goalOptionsQuery(targetId ?? ""), enabled });
  return {
    personaName: (personaId) => personas.data?.find((persona) => persona.id === personaId)?.name ?? null,
    goalTitle: (goalId) => goals.data?.find((goal) => goal.id === goalId)?.title ?? null,
    isLoading: enabled && (personas.isPending || goals.isPending),
  };
}
