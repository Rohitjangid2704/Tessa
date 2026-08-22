"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";

export default function TargetError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="This target page failed to load"
      description="Try again; if it keeps failing, report the reference below."
      requestId={readRequestId(error)}
      digest={error.digest}
      onRetry={retry}
    />
  );
}
