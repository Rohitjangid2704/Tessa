import { Hourglass } from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";

export type StubViewProps = { agent: string };

export function StubView({ agent }: StubViewProps) {
  return (
    <EmptyState
      icon={Hourglass}
      title="This run view is not built yet"
      description={`Arrives with ${agent}`}
      data-slot="stub-view"
    />
  );
}
