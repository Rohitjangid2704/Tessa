import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { apiBaseUrl, authedFetch } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";

export const frameRunResponseSchema = z.object({
  run_id: z.string(),
  sessions: z.array(z.object({ id: z.string(), title: z.string() })),
});

export type FrameRunResponse = z.infer<typeof frameRunResponseSchema>;

export const FRAME_RUN_UNAVAILABLE_MESSAGE =
  "The tile spike needs the mock API (npm run mock:api): the real API has no frame source until Phase 2";

export async function startFrameRun(sessions: number): Promise<FrameRunResponse> {
  const response = await authedFetch(
    new Request(`${apiBaseUrl}/__mock/frame-runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ sessions }),
    }),
  );
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 404 || response.status === 405) {
    throw new ApiError({
      status: response.status,
      code: "not_found",
      message: FRAME_RUN_UNAVAILABLE_MESSAGE,
    });
  }
  if (!response.ok) {
    throw ApiError.fromResponse(response, body);
  }
  return frameRunResponseSchema.parse(body);
}

export function useStartFrameRun() {
  return useMutation({ mutationFn: startFrameRun });
}
