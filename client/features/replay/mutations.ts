import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fileFingerprint, useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { isUploadAbort, type UploadProgress } from "@/lib/api/upload";
import { runRoutes } from "@/lib/routes";
import { uploadReplayRequest } from "./upload-request";

export interface UploadReplayVariables {
  file: File;
  targetId: string;
  note: string;
  idempotencyKey: string;
}

export function useUploadReplay() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const keys = useAttemptKeys();
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);

  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (variables: UploadReplayVariables) => {
      const abort = new AbortController();
      controller.current = abort;
      return uploadReplayRequest({
        ...variables,
        signal: abort.signal,
        onProgress: setProgress,
      });
    },
    onSuccess: (replay) => {
      keys.settle();
      void queryClient.invalidateQueries({ queryKey: qk.replays.all() });
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      router.push(runRoutes.detail(replay.run_id));
    },
    onError: () => setProgress(null),
    onSettled: () => {
      controller.current = null;
    },
  });

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  function upload(file: File, targetId: string, note: string): void {
    mutation.mutate({
      file,
      targetId,
      note,
      idempotencyKey: keys.keyFor(fileFingerprint(file, targetId, note)),
    });
  }

  function cancel(): void {
    controller.current?.abort();
  }

  return {
    upload,
    cancel,
    progress,
    isPending: mutation.isPending,
    error: isUploadAbort(mutation.error) ? null : mutation.error,
    reset: () => {
      mutation.reset();
      setProgress(null);
    },
  };
}
