import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import type { ErrorBody, ErrorResponse } from "@/mocks/types";
import { bearer, mintApiToken } from "./tokens";

export { STAGE_ONE_IDS };

export type Role = "admin" | "member" | "viewer";

export interface Stage1Client {
  baseUrl: string;
  headers: (role?: Role) => Promise<Record<string, string>>;
  get: (path: string, role?: Role) => Promise<Response>;
  send: (
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options?: { role?: Role; headers?: Record<string, string> },
  ) => Promise<Response>;
  upload: (options: UploadOptions) => Promise<Response>;
}

export interface UploadOptions {
  name: string;
  type?: string;
  bytes?: Uint8Array<ArrayBuffer>;
  targetId?: string;
  note?: string;
  key?: string | null;
  role?: Role;
}

const EMPTY_ZIP: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x50,
  0x4b,
  0x05,
  0x06,
  ...new Array<number>(18).fill(0),
]);

const USERS = { member: MEMBER_USER, viewer: VIEWER_USER } as const;

export function createStage1Client(baseUrl: string): Stage1Client {
  const headers = async (role: Role = "admin") =>
    bearer(await mintApiToken(role === "admin" ? undefined : { user: USERS[role] }));

  return {
    baseUrl,
    headers,
    get: async (path, role) => fetch(`${baseUrl}${path}`, { headers: await headers(role) }),
    send: async (method, path, body, options = {}) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(await headers(options.role)),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    upload: async (options) => {
      const form = new FormData();
      form.set(
        "file",
        new File([options.bytes ?? EMPTY_ZIP], options.name, {
          type: options.type ?? "application/zip",
        }),
      );
      if (options.targetId !== undefined) {
        form.set("target_id", options.targetId);
      }
      if (options.note !== undefined) {
        form.set("note", options.note);
      }
      const key = options.key === undefined ? crypto.randomUUID() : options.key;
      return fetch(`${baseUrl}/api/v1/bundles`, {
        method: "POST",
        headers: {
          ...(await headers(options.role)),
          ...(key === null ? {} : { "Idempotency-Key": key }),
        },
        body: form,
      });
    },
  };
}

export async function errorOf(response: Response): Promise<ErrorBody> {
  const body = (await response.json()) as ErrorResponse;
  return body.error;
}
