import { clientEnv } from "@/lib/env.client";

export function resolveArtifactUrl(
  url: string,
  apiBaseUrl: string = clientEnv.NEXT_PUBLIC_API_URL,
) {
  const resolved = new URL(url, apiBaseUrl);
  return resolved.protocol === "http:" || resolved.protocol === "https:"
    ? resolved.toString()
    : null;
}
