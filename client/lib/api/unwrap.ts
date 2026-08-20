import { ApiError } from "./errors";

type Settled = { data?: unknown; error?: unknown; response: Response };

type SuccessData<Result extends Settled> = Extract<Result, { data: unknown }>["data"];

export async function unwrap<Result extends Settled>(
  pending: PromiseLike<Result>,
): Promise<SuccessData<Result>> {
  const result = await pending;
  if (!result.response.ok) {
    throw ApiError.fromResponse(result.response, result.error);
  }
  return result.data as SuccessData<Result>;
}
