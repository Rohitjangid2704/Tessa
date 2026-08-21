import { Bot, Braces, Clock, User } from "lucide-react";
import type { RunTrigger } from "@/lib/api/types";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";

export type RunTriggerValue = RunTrigger | "agent";

const triggerPresentation = {
  manual: { tone: "hollow", label: "Manual", icon: User, title: "Started from the web app" },
  schedule: { tone: "hollow", label: "Scheduled", icon: Clock, title: "Started by a schedule" },
  api: { tone: "hollow", label: "API", icon: Braces, title: "Started with the service key" },
  agent: {
    tone: "tier-laya",
    label: "From Claude Code",
    icon: Bot,
    title: "Started from Claude Code with a personal token",
  },
} as const satisfies Record<
  RunTriggerValue,
  Pick<StatusBadgeProps, "tone" | "label" | "icon" | "title">
>;

export function RunTriggerBadge({
  trigger,
  ...props
}: { trigger: RunTriggerValue } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge data-trigger={trigger} {...triggerPresentation[trigger]} {...props} />;
}
