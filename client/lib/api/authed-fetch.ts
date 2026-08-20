import { signOutRejectedSession, type RejectedSessionReason } from "@/lib/auth/session-rejected";
import { SessionExpiredError, getToken, refreshToken } from "@/lib/auth/token-client";
import { loginPath, routes } from "@/lib/routes";
import { ApiError, TOKEN_UNAVAILABLE_CODE } from "./errors";

export const RETRYABLE_UNAUTHENTICATED_CODES: ReadonlySet<string> = new Set([
  "token_expired",
  "unauthenticated",
]);

const DEACTIVATED_MESSAGE_PATTERN = /inactive|deactivated|disabled/i;

export type AuthedFetchDependencies = {
  getToken: () => Promise<string>;
  refreshToken: (rejectedToken: string) => Promise<string>;
  redirectToLogin: () => void;
  signOutRejectedSession?: (reason: RejectedSessionReason) => void;
  fetch?: (request: Request) => Promise<Response>;
  createRequestId?: () => string;
};

let redirectingToLogin = false;

export function redirectToLogin(): void {
  if (typeof window === "undefined" || redirectingToLogin) {
    return;
  }
  const { pathname, search } = window.location;
  if (pathname === routes.login) {
    return;
  }
  redirectingToLogin = true;
  window.location.assign(loginPath(`${pathname}${search}`));
}

async function isRetryableUnauthenticated(response: Response): Promise<boolean> {
  if (response.status !== 401) {
    return false;
  }
  try {
    const body: unknown = await response.clone().json();
    const code = ApiError.fromResponse(response, body).code;
    return RETRYABLE_UNAUTHENTICATED_CODES.has(code);
  } catch {
    return true;
  }
}

async function rejectionReason(response: Response): Promise<RejectedSessionReason> {
  try {
    const body: unknown = await response.clone().json();
    const message = ApiError.fromResponse(response, body).message;
    return DEACTIVATED_MESSAGE_PATTERN.test(message) ? "deactivated" : "invalid";
  } catch {
    return "invalid";
  }
}

function tokenUnavailable(cause: unknown): ApiError {
  return new ApiError({
    status: 0,
    code: TOKEN_UNAVAILABLE_CODE,
    message: "Could not obtain an API token",
    cause,
  });
}

function sessionExpiredResponse(): Response {
  return Response.json(
    {
      error: {
        code: "unauthenticated",
        message: "Your session has expired",
        request_id: "",
        details: [],
      },
    },
    { status: 401 },
  );
}

export function createAuthedFetch(dependencies: AuthedFetchDependencies) {
  const send = dependencies.fetch ?? ((request: Request) => fetch(request));
  const createRequestId = dependencies.createRequestId ?? (() => crypto.randomUUID());

  async function sendWithToken(request: Request, token: string): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("X-Request-ID")) {
      headers.set("X-Request-ID", createRequestId());
    }
    try {
      return await send(new Request(request, { headers }));
    } catch (cause) {
      throw ApiError.network(cause);
    }
  }

  return async function authedFetch(request: Request): Promise<Response> {
    const pristine = request.clone();

    let token: string;
    try {
      token = await dependencies.getToken();
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        dependencies.redirectToLogin();
        return sessionExpiredResponse();
      }
      throw tokenUnavailable(error);
    }

    const response = await sendWithToken(request, token);
    if (!(await isRetryableUnauthenticated(response))) {
      return response;
    }

    let freshToken: string;
    try {
      freshToken = await dependencies.refreshToken(token);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        dependencies.redirectToLogin();
        return response;
      }
      throw tokenUnavailable(error);
    }

    const retried = await sendWithToken(pristine, freshToken);
    if (retried.status === 401) {
      if (dependencies.signOutRejectedSession === undefined) {
        dependencies.redirectToLogin();
      } else {
        dependencies.signOutRejectedSession(await rejectionReason(retried));
      }
    }
    return retried;
  };
}

export const authedFetch = createAuthedFetch({
  getToken,
  refreshToken,
  redirectToLogin,
  signOutRejectedSession: (reason) => signOutRejectedSession(reason, redirectToLogin),
});
