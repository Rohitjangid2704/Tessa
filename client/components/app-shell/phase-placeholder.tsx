import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";
import { PageHeader } from "./page-header";

export type PhasePlaceholderProps = {
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  phase: number;
  icon: LucideIcon;
};

export function PhasePlaceholder({
  title,
  description,
  emptyTitle,
  emptyDescription,
  phase,
  icon,
}: PhasePlaceholderProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState title={emptyTitle} description={emptyDescription} phase={phase} icon={icon} />
    </>
  );
}
