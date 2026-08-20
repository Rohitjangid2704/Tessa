import "server-only";
import {
  describeEnvIssues,
  pickEnv,
  serverEnvKeys,
  serverEnvSchema,
  type ServerEnv,
} from "./env.schema";

export type { ServerEnv };

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(pickEnv(source, serverEnvKeys));
  if (!result.success) {
    throw new Error(describeEnvIssues("server", result.error));
  }
  return result.data;
}

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}
