import { useState } from "react";
import type { SettingsPatch } from "@/lib/api/types";
import type { SaveFailure } from "./errors";
import { describeGroupFailure } from "./group-errors";
import { usePatchSettings } from "./mutations";

export interface GroupSave {
  submit: (patch: SettingsPatch, message?: string) => void;
  clearFeedback: () => void;
  isSaving: boolean;
  failure: SaveFailure | null;
  savedMessage: string | null;
}

export function useGroupSave(
  group: string,
  leaves: readonly string[],
  successMessage: string,
): GroupSave {
  const save = usePatchSettings();
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  function clearFeedback(): void {
    setFailure(null);
    setSavedMessage(null);
  }

  function submit(patch: SettingsPatch, message: string = successMessage): void {
    clearFeedback();
    save.mutate(patch, {
      onSuccess: () => setSavedMessage(message),
      onError: (error) => setFailure(describeGroupFailure(error, group, leaves)),
      onSettled: () => save.reset(),
    });
  }

  return { submit, clearFeedback, isSaving: save.isPending, failure, savedMessage };
}
