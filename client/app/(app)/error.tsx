"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";

export default function AppError({
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
    <div className="mx-auto w-full max-w-2xl p-6">
      <ErrorState
        title="Something went wrong"
        description="This page failed to load. Try again; if it keeps failing, report the reference below."
        requestId={readRequestId(error)}
        digest={error.digest}
        onRetry={retry}
      />
    </div>
  );
}
