import { clientEnvSchema, describeEnvIssues, type ClientEnv } from "./env.schema";

export type { ClientEnv };

const result = clientEnvSchema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_PLUGIN_SOURCE: process.env.NEXT_PUBLIC_PLUGIN_SOURCE,
});

if (!result.success) {
  throw new Error(describeEnvIssues("client", result.error));
}

export const clientEnv: ClientEnv = result.data;
