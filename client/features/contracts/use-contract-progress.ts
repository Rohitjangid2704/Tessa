import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { qk } from "@/lib/api/query-keys";
import { createStore, useStore } from "@/lib/store";
import { useRunSocket } from "@/lib/ws/use-run-socket";
import { progressFromPayload, type CheckProgress } from "./model";

export function useContractProgress(runId: string, live: boolean): CheckProgress | null {
  const queryClient = useQueryClient();
  const [store] = useState(() => createStore<CheckProgress | null>(null));

  useRunSocket(runId, {
    enabled: live,
    onEvent: (event) => {
      if (event.type === "contract.progress") {
        store.setState(progressFromPayload(event.payload));
        return;
      }
      if (event.type === "run.finished") {
        void queryClient.invalidateQueries({ queryKey: qk.contracts.all() });
      }
    },
  });

  return useStore(store);
}
