import { http } from "msw";
import { REQUEST_ID_HEADER } from "../config";
import { forbidden, MockApiError, notFound } from "../factories/errors";
import { fileNameOf, mediaBytes, parseRange, verifyArtifactToken } from "../stage2/artifacts";
import { stageTwo } from "../stage2/support";
import { api, pathParam, type ApiContext } from "./api";

const RANGE_NOT_SATISFIABLE = 416;
const PARTIAL_CONTENT = 206;

function readArtifact(context: ApiContext): Response {
  const token = decodeURIComponent(pathParam(context, "token"));
  const verdict = verifyArtifactToken(token, context.state.config.wsTicketSigningKey, Date.now());
  if (!verdict.ok) {
    throw forbidden(
      verdict.reason === "expired"
        ? "The artifact URL has expired; fetch the step again for a new one"
        : "The artifact URL signature is not valid",
    );
  }
  const def = stageTwo(context).findArtifact(verdict.claims.artifactId);
  if (def === undefined) {
    throw notFound("Artifact not found");
  }
  const bytes = mediaBytes(def.fixture);
  const baseHeaders: Record<string, string> = {
    "Content-Type": def.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${def.fixture === "zip" ? "attachment" : "inline"}; filename="${fileNameOf(def)}"`,
    [REQUEST_ID_HEADER]: context.requestId,
  };
  const range = parseRange(context.request.headers.get("range"), bytes.length);
  if (range === "invalid") {
    throw new MockApiError(
      RANGE_NOT_SATISFIABLE,
      "range_not_satisfiable",
      "The requested range is outside the file",
      [],
      { "Content-Range": `bytes */${bytes.length}` },
    );
  }
  if (range === null) {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(bytes.length) },
    });
  }
  const slice = bytes.subarray(range.start, range.end + 1);
  return new Response(new Uint8Array(slice), {
    status: PARTIAL_CONTENT,
    headers: {
      ...baseHeaders,
      "Content-Length": String(slice.length),
      "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`,
    },
  });
}

export const artifactHandlers = [http.get("*/api/v1/artifacts/:token", api(readArtifact))];
