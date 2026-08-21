"use client";

import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useObjectUrl } from "@/lib/use-object-url";
import { cn } from "@/lib/utils";

export type SandboxedFrameProps = Omit<
  ComponentProps<"iframe">,
  "src" | "srcDoc" | "sandbox" | "children" | "title" | "referrerPolicy" | "allow"
> & {
  blob: Blob;
  title: string;
};

export function SandboxedFrame({ blob, title, className, ...props }: SandboxedFrameProps) {
  const url = useObjectUrl(blob);
  if (url === null) {
    return (
      <div role="status" aria-busy="true" className={className}>
        <span className="sr-only">Preparing {title}</span>
        <Skeleton className="h-full min-h-48 w-full" />
      </div>
    );
  }
  return (
    <iframe
      {...props}
      data-slot="sandboxed-frame"
      title={title}
      src={url}
      sandbox=""
      referrerPolicy="no-referrer"
      allow=""
      className={cn("border-0 bg-white", className)}
    />
  );
}
