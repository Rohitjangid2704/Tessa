import { isApiError } from "@/lib/api/errors";

export const SKEPTIC_NOT_INDEPENDENT_CODE = "skeptic_not_independent";

export const SKEPTIC_NOT_INDEPENDENT_MESSAGE =
  "The skeptic model must differ from the attack model.";

export function isSkepticNotIndependent(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 422 &&
    error.details.some((detail) => detail.code === SKEPTIC_NOT_INDEPENDENT_CODE)
  );
}
