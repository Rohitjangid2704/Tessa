"use client";

import { Upload } from "lucide-react";
import { useId, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  describeRejection,
  pickFile,
  type FileDropRules,
  type FileRejection,
} from "./file-drop-rules";

export interface FileDropZoneProps {
  title: string;
  description?: ReactNode;
  extensions: readonly string[];
  acceptMediaTypes?: readonly string[];
  maxBytes: number | null;
  disabled?: boolean;
  onFile: (file: File) => void;
  onReject?: (rejection: FileRejection) => void;
  className?: string;
}

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes("Files");
}

function carriesDirectory(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.items ?? []).some(
    (item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory === true,
  );
}

export function FileDropZone({
  title,
  description,
  extensions,
  acceptMediaTypes = [],
  maxBytes,
  disabled = false,
  onFile,
  onReject,
  className,
}: FileDropZoneProps) {
  const inputId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [rejection, setRejection] = useState<FileRejection | null>(null);
  const rules: FileDropRules = { extensions, maxBytes };
  const showDragging = dragging && !disabled;

  function reject(next: FileRejection): void {
    setRejection(next);
    onReject?.(next);
  }

  function accept(files: ArrayLike<File>): void {
    const picked = pickFile(files, { extensions, maxBytes });
    if (picked.rejection !== null) {
      reject(picked.rejection);
      return;
    }
    setRejection(null);
    onFile(picked.file);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length > 0) {
      accept(files);
    }
  }

  function handleDragEnter(event: DragEvent<HTMLElement>): void {
    if (disabled || !carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>): void {
    if (disabled || !carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(): void {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setDragging(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (disabled) {
      return;
    }
    if (carriesDirectory(event)) {
      reject({ reason: "directory" });
      return;
    }
    accept(Array.from(event.dataTransfer.files));
  }

  const describedBy = [description === undefined ? null : descriptionId, rejection ? errorId : null]
    .filter((id): id is string => id !== null)
    .join(" ");

  return (
    <div
      data-slot="file-drop-zone"
      data-dragging={showDragging}
      data-disabled={disabled}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "rounded-xl border-2 border-dashed p-6 text-center transition-colors has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 data-[disabled=true]:opacity-60 data-[dragging=true]:border-primary data-[dragging=true]:bg-primary/5",
        className,
      )}
    >
      <input
        id={inputId}
        type="file"
        accept={[...extensions, ...acceptMediaTypes].join(",")}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        aria-invalid={rejection !== null}
        onChange={handleChange}
        className="sr-only"
      />
      <label
        htmlFor={inputId}
        className={cn(
          "flex flex-col items-center gap-2",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <Upload aria-hidden="true" className="size-8 text-muted-foreground" />
        <span id={titleId} className="font-medium">
          {title}
        </span>
        <span aria-hidden="true" className="text-sm text-muted-foreground">
          {showDragging ? "Release to choose this file" : "Drag a file here or "}
          {showDragging ? null : <span className="underline underline-offset-4">browse</span>}
        </span>
      </label>
      {description === undefined ? null : (
        <div id={descriptionId} className="mt-3 text-xs text-muted-foreground">
          {description}
        </div>
      )}
      {rejection === null ? null : (
        <p id={errorId} role="alert" className="mt-3 text-sm font-medium text-destructive">
          {describeRejection(rejection, rules)}
        </p>
      )}
    </div>
  );
}
