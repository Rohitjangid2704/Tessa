import { http } from "msw";
import { conflict, MockApiError, notFound, validationFailed } from "../factories/errors";
import { newId } from "../factories/ids";
import { QueryReader, readPage } from "../factories/pagination";
import { parseJsonObject } from "../factories/validation";
import { BodyReader } from "../stage1/body";
import { hashParts, pathUuid, withIdempotency } from "../stage1/support";
import {
  activeAdminCount,
  isRoleLowered,
  isValidEmail,
  matchesSearch,
  rowsOf,
  toUser,
  USER_EMAIL_MAX,
  USER_NAME_MAX,
  USER_PAGE,
  USER_PASSWORD_MAX,
  USER_PASSWORD_MIN,
  USER_ROLES,
  USER_SEARCH_MAX,
} from "../stage10/users-service";
import { usersStore } from "../stage10/users-store";
import type { MockUser } from "../types";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

const EMAIL_TAKEN_MESSAGE = "A user with this email already exists";
const SELF_ROLE_MESSAGE = "You cannot lower your own role";
const SELF_DEACTIVATE_MESSAGE = "You cannot deactivate your own account";
const LAST_ADMIN_MESSAGE = "At least one active admin must remain";
const INVALID_EMAIL_MESSAGE = "value is not a valid email address";

async function listUsers(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  usersStore.ensure(context.state);
  const query = new QueryReader(context.url.searchParams);
  const text = query.text("q", { max: USER_SEARCH_MAX });
  const roles = query.enumList("role", USER_ROLES);
  const activeFilter = context.url.searchParams.has("is_active")
    ? query.boolean("is_active", true)
    : undefined;
  const paginate = readPage(query, USER_PAGE);
  query.finish();

  const needle = text?.trim().toLowerCase();
  const rows = rowsOf(context.state.users, usersStore)
    .filter((row) => needle === undefined || needle === "" || matchesSearch(row, needle))
    .filter((row) => roles === undefined || roles.includes(row.user.role))
    .filter((row) => activeFilter === undefined || row.user.isActive === activeFilter);
  const page = paginate(rows);
  return jsonResponse({ ...page, items: page.items.map(toUser) });
}

async function createUser(context: ApiContext): Promise<Response> {
  const caller = await requireUser(context, "admin");
  usersStore.ensure(context.state);
  const raw = parseJsonObject(await context.request.text());
  const body = new BodyReader(raw);
  const email = body.string("email", { required: true, min: 3, max: USER_EMAIL_MAX, strip: true });
  const name = body.string("name", { required: true, min: 1, max: USER_NAME_MAX, strip: true });
  const role = body.enum("role", USER_ROLES, { required: true });
  const password = body.string("password", {
    required: false,
    nullable: true,
    min: USER_PASSWORD_MIN,
    max: USER_PASSWORD_MAX,
  });
  if (typeof email === "string" && !isValidEmail(email)) {
    body.issue("email", "value_error", INVALID_EMAIL_MESSAGE);
  }
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }

  return withIdempotency(
    context,
    caller,
    { required: false, requestHash: hashParts(JSON.stringify(raw)) },
    () => {
      const address = String(email);
      if (context.state.findUserByEmail(address) !== undefined) {
        throw new MockApiError(409, "conflict", EMAIL_TAKEN_MESSAGE, [
          { loc: ["body", "email"], code: "duplicate_email", message: EMAIL_TAKEN_MESSAGE },
        ]);
      }
      const created: MockUser = {
        id: newId(),
        email: address,
        name: String(name),
        role: role as MockUser["role"],
        password: typeof password === "string" ? password : "",
        isActive: true,
      };
      const profile = { createdAt: new Date().toISOString(), lastLoginAt: null, teamIds: [] };
      usersStore.add(context.state, created, profile);
      return { status: 201, body: toUser({ user: created, profile }) };
    },
  );
}

async function updateUser(context: ApiContext): Promise<Response> {
  const caller = await requireUser(context, "admin");
  usersStore.ensure(context.state);
  const userId = pathUuid(context, "user_id");
  const body = new BodyReader(parseJsonObject(await context.request.text()));
  const name = body.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: USER_NAME_MAX,
    strip: true,
  });
  const role = body.enum("role", USER_ROLES, { required: false, nullable: true });
  const isActive = body.boolean("is_active", { nullable: true });
  if (body.details.length > 0) {
    throw validationFailed(body.details);
  }
  const target = context.state.findUserById(userId);
  if (target === undefined) {
    throw notFound("User not found");
  }

  const isSelf = target.id === caller.id;
  const nextRole = role ?? target.role;
  const nextActive = isActive ?? target.isActive;
  if (isSelf && isRoleLowered(target.role, nextRole)) {
    throw conflict("conflict", SELF_ROLE_MESSAGE);
  }
  if (isSelf && target.isActive && !nextActive) {
    throw conflict("conflict", SELF_DEACTIVATE_MESSAGE);
  }
  const losesAdmin =
    target.role === "admin" && target.isActive && (nextRole !== "admin" || !nextActive);
  if (losesAdmin && activeAdminCount(context.state.users) <= 1) {
    throw conflict("conflict", LAST_ADMIN_MESSAGE);
  }

  if (typeof name === "string") {
    target.name = name;
  }
  target.role = nextRole;
  target.isActive = nextActive;
  return jsonResponse(toUser({ user: target, profile: usersStore.profileOf(target.id) }));
}

export const userHandlers = [
  http.get("*/api/v1/users", api(listUsers)),
  http.post("*/api/v1/users", api(createUser)),
  http.patch("*/api/v1/users/:user_id", api(updateUser)),
];
