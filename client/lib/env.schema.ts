import { z } from "zod";

const MINIMUM_SECRET_LENGTH = 32;
const MINIMUM_TOKEN_TTL_SECONDS = 61;

const httpUrl = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ""));

const secret = z.string().min(MINIMUM_SECRET_LENGTH);

const positiveInteger = z.coerce.number().int().positive();

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const optionalText = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const optionalIssuerUrl = z.preprocess(
  emptyToUndefined,
  z.url({ protocol: /^https?$/ }).optional(),
);

const optionalBooleanText = z.preprocess(emptyToUndefined, z.enum(["true", "false"]).optional());

const booleanFlag = (defaultValue: boolean) =>
  optionalBooleanText.transform((value) => (value === undefined ? defaultValue : value === "true"));

export const oidcEnvKeys = [
  "AUTH_OIDC_ISSUER",
  "AUTH_OIDC_CLIENT_ID",
  "AUTH_OIDC_CLIENT_SECRET",
] as const;

export const clientEnvSchema = z.strictObject({
  NEXT_PUBLIC_API_URL: httpUrl,
  NEXT_PUBLIC_PLUGIN_SOURCE: optionalText,
});

export const serverEnvSchema = z
  .strictObject({
    API_INTERNAL_URL: httpUrl,
    AUTH_SECRET: secret,
    AUTH_URL: httpUrl,
    AUTH_SESSION_MAX_AGE_SECONDS: positiveInteger,
    API_JWT_SECRET: secret,
    API_JWT_ISSUER: z.string().min(1),
    API_JWT_AUDIENCE: z.string().min(1),
    API_JWT_TTL_SECONDS: positiveInteger.min(MINIMUM_TOKEN_TTL_SECONDS),
    API_SERVICE_KEY: secret,
    AUTH_TRUST_HOST: z
      .enum(["true", "false"])
      .optional()
      .transform((value) => value === "true"),
    AUTH_OIDC_ISSUER: optionalIssuerUrl,
    AUTH_OIDC_CLIENT_ID: optionalText,
    AUTH_OIDC_CLIENT_SECRET: optionalText,
    AUTH_PASSWORD_LOGIN_ENABLED: booleanFlag(true),
    CSP_ENFORCE: booleanFlag(false),
  })
  .superRefine((env, context) => {
    if (env.AUTH_SECRET === env.API_JWT_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message: "AUTH_SECRET must differ from API_JWT_SECRET",
      });
    }
    if (env.AUTH_SECRET === env.API_SERVICE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message: "AUTH_SECRET must differ from API_SERVICE_KEY",
      });
    }
    const missingOidcKeys = oidcEnvKeys.filter((key) => env[key] === undefined);
    const oidcFullySet = missingOidcKeys.length === 0;
    const oidcNotSet = missingOidcKeys.length === oidcEnvKeys.length;
    if (!oidcFullySet && !oidcNotSet) {
      for (const key of missingOidcKeys) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "set all three AUTH_OIDC_* keys or none of them",
        });
      }
    }
    if (!env.AUTH_PASSWORD_LOGIN_ENABLED && !oidcFullySet) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_PASSWORD_LOGIN_ENABLED"],
        message: "AUTH_PASSWORD_LOGIN_ENABLED=false needs all three AUTH_OIDC_* keys",
      });
    }
  });

export const e2eEnvSchema = z.strictObject({
  E2E_BASE_URL: z.preprocess(emptyToUndefined, httpUrl.optional()),
  E2E_USER_EMAIL: optionalText,
  E2E_USER_PASSWORD: optionalText,
  E2E_GRACIE_ZIP: optionalText,
  E2E_GRACIE_ENV_FILE: optionalText,
  E2E_API_DATA_DIR: optionalText,
  E2E_LOG_FILES: optionalText,
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type E2eEnv = z.infer<typeof e2eEnvSchema>;

export const clientEnvKeys = Object.keys(clientEnvSchema.shape);
export const serverEnvKeys = Object.keys(serverEnvSchema.shape);
export const e2eEnvKeys = Object.keys(e2eEnvSchema.shape);

export function pickEnv(source: Record<string, string | undefined>, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

export function describeEnvIssues(scope: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.length > 0 ? issue.path.join(".") : "(env)";
    return `  ${key}: ${issue.message}`;
  });
  return `Invalid ${scope} environment:\n${lines.join("\n")}`;
}
