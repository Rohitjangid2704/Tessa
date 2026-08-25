import type { AgentSession } from "@/lib/api/types";
import type { PageSpec } from "../factories/pagination";

export const AGENT_SESSION_PAGE: PageSpec<AgentSession> = {
  sortKeys: {
    started_at: { kind: "timestamp", value: (session) => session.started_at },
  },
  defaultSort: "-started_at",
  getId: (session) => session.id,
};
