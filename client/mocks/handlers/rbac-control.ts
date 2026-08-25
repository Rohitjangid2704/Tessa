import { http } from "msw";
import { z } from "zod";
import { notFound, validationFailed } from "../factories/errors";
import { parseJsonObject } from "../factories/validation";
import type { ErrorDetail, MockUser } from "../types";
import { api, jsonResponse, type ApiContext } from "./api";

const CONTROL_OPTIONS = { applyLatency: false };

const userChangeSchema = z
  .strictObject({
    email: z.string().min(1),
    role: z.enum(["viewer", "member", "admin"]).optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => body.role !== undefined || body.is_active !== undefined, {
    message: "Send role, is_active or both",
  });

function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        loc: ["body", key],
        code: "extra_forbidden",
        message: "Extra inputs are not permitted",
      }));
    }
    return [
      {
        loc: ["body", ...issue.path.map((segment) => String(segment))],
        code: issue.code,
        message: issue.message,
      },
    ];
  });
}

function describeUser(user: MockUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    is_active: user.isActive,
  };
}

function listUsers(context: ApiContext): Response {
  return jsonResponse({ users: context.state.users.map(describeUser) });
}

async function changeUser(context: ApiContext): Promise<Response> {
  const parsed = userChangeSchema.safeParse(parseJsonObject(await context.request.text()));
  if (!parsed.success) {
    throw validationFailed(toDetails(parsed.error));
  }
  const user = context.state.findUserByEmail(parsed.data.email);
  if (user === undefined) {
    throw notFound("User not found");
  }
  user.role = parsed.data.role ?? user.role;
  user.isActive = parsed.data.is_active ?? user.isActive;
  return jsonResponse({ user: describeUser(user) });
}

export const rbacControlHandlers = [
  http.get("*/__mock/rbac/users", api(listUsers, CONTROL_OPTIONS)),
  http.post("*/__mock/rbac/users", api(changeUser, CONTROL_OPTIONS)),
];
