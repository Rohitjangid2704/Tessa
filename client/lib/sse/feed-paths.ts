import type { FeedName } from "@/lib/api/types";

export const FEED_PATH_PREFIX = "/api/v1/feeds/";

export function feedPath(feed: FeedName): string {
  return `${FEED_PATH_PREFIX}${feed}`;
}
