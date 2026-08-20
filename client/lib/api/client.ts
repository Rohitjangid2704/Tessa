import createClient from "openapi-fetch";
import { clientEnv } from "@/lib/env.client";
import { authedFetch } from "./authed-fetch";
import type { MergedPaths } from "./interim";

export const apiBaseUrl = clientEnv.NEXT_PUBLIC_API_URL;

export const api = createClient<MergedPaths>({ baseUrl: apiBaseUrl, fetch: authedFetch });

export { authedFetch };
