import { z, type ZodRawShape } from "zod";
import type { Clock, TessaApi } from "../client";
import { MAX_RESULT_BYTES } from "../cut";
import { asApiError, localError, type ApiError } from "../errors";
import type { InboxStore } from "../inbox-store";
import type { Redactor } from "../redact";
import type { SessionTracker } from "../session";

export type ToolContext = {
  api: TessaApi;
  session: SessionTracker;
  redactor: Redactor;
  clock: Clock;
  generateId: () => string;
  tokenPrefix: string;
  inbox: InboxStore;
  log: (message: string, fields?: Record<string, unknown>) => void;
};

export type ToolAccess = "read" | "write";

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  destructive: boolean;
  idempotent: boolean;
  input: ZodRawShape;
  run: (context: ToolContext, args: unknown) => Promise<unknown>;
};

export type ToolSpec<Shape extends ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  destructive?: boolean;
  idempotent?: boolean;
  input: Shape;
  handler: (context: ToolContext, args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>;
};

export function defineTool<Shape extends ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
  const schema = z.object(spec.input);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    access: spec.access,
    destructive: spec.destructive ?? false,
    idempotent: spec.idempotent ?? spec.access === "read",
    input: spec.input,
    run: (context, args) => spec.handler(context, schema.parse(args)),
  };
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(value: unknown, isError: boolean): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
  if (isError) {
    result.isError = true;
  }
  return result;
}

const TRUNCATION_NOTE = "The result exceeded the size limit; narrow the request";

function endOnWholeCharacter(text: string, end: number): number {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

function fitToLimit(text: string): string {
  const bytes = Buffer.byteLength(text);
  if (bytes <= MAX_RESULT_BYTES) {
    return text;
  }
  const envelope = (end: number) =>
    JSON.stringify({ truncated: true, original_bytes: bytes, note: TRUNCATION_NOTE, preview: text.slice(0, end) });
  let low = 0;
  let high = Math.min(text.length, MAX_RESULT_BYTES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(envelope(middle)) <= MAX_RESULT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return envelope(endOnWholeCharacter(text, low));
}

function invalidArguments(error: z.ZodError): ApiError {
  const details = error.issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    loc: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
  }));
  return localError("invalid_arguments", "The tool arguments are invalid", details);
}

export async function executeTool(
  definition: ToolDefinition,
  context: ToolContext,
  args: unknown,
): Promise<ToolResult> {
  try {
    await context.session.settled();
    const value = await definition.run(context, args);
    const redacted = context.redactor.value(value ?? { ok: true });
    return { content: [{ type: "text", text: fitToLimit(JSON.stringify(redacted)) }] };
  } catch (error) {
    const apiError = error instanceof z.ZodError ? invalidArguments(error) : asApiError(error);
    return textResult(context.redactor.value({ error: apiError.toJSON() }), true);
  }
}
