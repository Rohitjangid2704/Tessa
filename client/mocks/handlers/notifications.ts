import { http } from "msw";
import type { Notification as AppNotification, NotificationKind } from "@/lib/api/types";
import { notFound } from "../factories/errors";
import { parseBooleanText, QueryReader, readPage, type PageSpec } from "../factories/pagination";
import { pathUuid } from "../stage1/support";
import { stageEight } from "../stage8/store";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

export const NOTIFICATION_KINDS = [
  "run_finished",
  "nightly_summary",
  "finding_regression",
  "budget_exceeded",
  "mutant_survived",
  "schedule_failed",
] as const satisfies readonly NotificationKind[];

const NOTIFICATION_PAGE: PageSpec<AppNotification> = {
  sortKeys: { created_at: { kind: "timestamp", value: (row) => row.created_at } },
  defaultSort: "-created_at",
  getId: (row) => row.id,
};

async function listNotifications(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const query = new QueryReader(context.url.searchParams);
  const unreadText = query.text("unread");
  const unread = unreadText === undefined ? null : parseBooleanText(unreadText);
  if (unreadText !== undefined && unread === null) {
    query.details.push({
      loc: ["query", "unread"],
      code: "bool_parsing",
      message: "Input should be a valid boolean, unable to interpret input",
    });
  }
  const kinds = query.enumList("kind", NOTIFICATION_KINDS);
  const paginate = readPage(query, NOTIFICATION_PAGE);
  query.finish();

  const rows = stageEight.notifications.all
    .filter((entry) => unread === null || (entry.read_at === null) === unread)
    .filter((entry) => kinds === undefined || kinds.includes(entry.kind));
  return jsonResponse(paginate(rows));
}

async function markNotificationRead(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  const notificationId = pathUuid(context, "notification_id");
  const updated = stageEight.notifications.markRead(notificationId);
  if (updated === undefined) {
    throw notFound("Notification not found");
  }
  return jsonResponse(updated);
}

async function markAllNotificationsRead(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  stageEight.notifications.markAllRead();
  return new Response(null, { status: 204 });
}

export const notificationHandlers = [
  http.get("*/api/v1/notifications", api(listNotifications)),
  http.post("*/api/v1/notifications/read-all", api(markAllNotificationsRead)),
  http.post("*/api/v1/notifications/:notification_id/read", api(markNotificationRead)),
];
