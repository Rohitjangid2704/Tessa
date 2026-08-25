import { http } from "msw";
import { stageOne } from "../stage1/support";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function readLimits(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  return jsonResponse({ ...stageOne(context).limits });
}

export const limitsHandlers = [http.get("*/api/v1/limits", api(readLimits))];
