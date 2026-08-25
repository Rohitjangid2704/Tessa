import { http, matchRequestUrl, type HttpHandler } from "msw";
import { methodNotAllowed, notFound } from "../factories/errors";
import { api } from "./api";

function allowedMethods(handlers: readonly HttpHandler[], url: URL): string[] {
  const methods = handlers.flatMap((handler) => {
    const { path, method } = handler.info;
    if (typeof path === "function" || !matchRequestUrl(url, path).matches) {
      return [];
    }
    return [String(method).toUpperCase()];
  });
  return [...new Set(methods)];
}

export function createFallbackHandlers(registered: readonly HttpHandler[]): HttpHandler[] {
  return [
    http.all(
      "*",
      api(({ url }) => {
        const allowed = allowedMethods(registered, url);
        if (allowed.length > 0) {
          throw methodNotAllowed(allowed);
        }
        throw notFound("Not Found");
      }),
    ),
  ];
}
