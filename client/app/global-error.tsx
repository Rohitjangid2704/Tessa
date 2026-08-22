"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import "./globals.css";

export default function GlobalError({
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
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <title>Something went wrong | Tessa</title>
        <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center p-6">
          <ErrorState
            title="Something went wrong"
            description="Tessa hit an unexpected error and could not render this page."
            requestId={readRequestId(error)}
            digest={error.digest}
            onRetry={retry}
          />
        </main>
      </body>
    </html>
  );
}
