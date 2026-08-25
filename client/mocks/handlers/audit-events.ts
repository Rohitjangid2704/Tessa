import { http } from "msw";
import { QueryReader, readPage } from "../factories/pagination";
import { AUDIT_PAGE, matchesAuditFilters, readAuditFilters } from "../stage11/audit-service";
import { auditStore } from "../stage11/audit-store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

async function listAuditEvents(context: ApiContext): Promise<Response> {
  await requireUser(context, "admin");
  const query = new QueryReader(context.url.searchParams);
  const filters = readAuditFilters(query);
  const paginate = readPage(query, AUDIT_PAGE);
  query.finish();
  const rows = auditStore.all().filter((event) => matchesAuditFilters(event, filters));
  return jsonResponse(paginate(rows));
}

export const auditEventHandlers = [http.get("*/api/v1/audit-events", api(listAuditEvents))];
