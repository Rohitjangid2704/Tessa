import { http } from "msw";
import { FieldValidator, parseJsonObject } from "../factories/validation";
import { DEFAULT_FRAME_SESSIONS } from "../server/frames";
import { MAX_FRAME_SESSIONS, startFrameRun } from "../simulation/frame-run";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function createFrameRun(context: ApiContext): Promise<Response> {
  const user = await requireUser(context, "viewer");
  const body = parseJsonObject((await context.request.text()) || "{}");
  const validator = new FieldValidator("body");
  const { sessions } = validator.finish({
    sessions: validator.integer(body, "sessions", {
      min: 1,
      max: MAX_FRAME_SESSIONS,
      fallback: DEFAULT_FRAME_SESSIONS,
    }),
  });
  const started = await startFrameRun(context.state, user, sessions);
  return jsonResponse(
    {
      run_id: started.run.id,
      sessions: started.sessions.map((session) => ({ id: session.id, title: session.title })),
    },
    { status: 201 },
  );
}

export const frameRunHandlers = [http.post("*/__mock/frame-runs", api(createFrameRun))];
