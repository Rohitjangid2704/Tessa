"use client";

import { ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { pluralize } from "../labels";

const ANNOUNCE_INTERVAL_MS = 5000;

export interface NewFindingsPillProps {
  count: number;
  onShow: () => void;
}

export function NewFindingsPill({ count, onShow }: NewFindingsPillProps) {
  const announced = useThrottledValue(count, ANNOUNCE_INTERVAL_MS);
  const word = pluralize(count, "finding");

  return (
    <div data-slot="new-findings-pill" className="flex items-center">
      <p role="status" aria-live="polite" className="sr-only">
        {announced === 0 ? "" : `${announced} new ${pluralize(announced, "finding")} available`}
      </p>
      {count === 0 ? null : (
        <Button type="button" variant="secondary" size="sm" onClick={onShow}>
          <ArrowUp aria-hidden="true" data-icon="inline-start" />
          {count} new {word}
        </Button>
      )}
    </div>
  );
}
