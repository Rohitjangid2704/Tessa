import { z } from "zod";
import type { components } from "@/lib/api/schema";

export const userRoleSchema = z.enum(["viewer", "member", "admin"]) satisfies z.ZodType<
  components["schemas"]["UserRole"]
>;

export type UserRole = z.infer<typeof userRoleSchema>;

export const authUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string(),
  role: userRoleSchema,
}) satisfies z.ZodType<components["schemas"]["AuthUser"]>;

export type AuthUser = z.infer<typeof authUserSchema>;

export const apiTokenResponseSchema = z.object({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
});

export type ApiTokenResponse = z.infer<typeof apiTokenResponseSchema>;

export const loginInputSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address."),
  password: z.string().min(1, "Enter your password."),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
