"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, Layers, Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { RunGroupDialog } from "@/features/runs/components/run-group-dialog";
import { RUN_GROUP_MAX_TARGETS, RUN_GROUP_MIN_TARGETS } from "@/features/runs/run-groups/schemas";
import { useCan } from "@/lib/auth/can";
import { targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { TargetListbox, type TargetComboboxOption } from "./components/target-combobox";
import { TierChip } from "./components/tier-chip";
import { rememberTarget, useCurrentTarget, useSwitchTarget } from "./current-target";
import { isTargetNotFound, targetOptionsQuery, targetQuery } from "./queries";

type SwitcherMode = "single" | "multiple";

const NO_IDS: readonly string[] = [];

export function TargetSwitcher() {
  const hydrated = useHydrated();
  const canRunGroups = useCan("runs.start_group");
  const canCreateTarget = useCan("targets.create");
  const hintId = useId();
  const { targetId, source } = useCurrentTarget();
  const switchTarget = useSwitchTarget();
  const options = useQuery(targetOptionsQuery());
  const current = useQuery({ ...targetQuery(targetId ?? ""), enabled: targetId !== null });
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SwitcherMode>("single");
  const [picked, setPicked] = useState<readonly string[]>(NO_IDS);
  const [groupTargetIds, setGroupTargetIds] = useState<readonly string[] | null>(null);

  const staleStoredTarget = source === "stored" && isTargetNotFound(current.error);
  useEffect(() => {
    if (staleStoredTarget) {
      rememberTarget(null);
    }
  }, [staleStoredTarget]);

  if (!hydrated || options.isPending) {
    return <Skeleton aria-hidden="true" className="h-8 w-56 max-w-full" />;
  }
  if (options.data === undefined) {
    return (
      <Button variant="ghost" size="sm" onClick={() => void options.refetch()}>
        Targets unavailable. Retry
      </Button>
    );
  }

  const activeTargetId = staleStoredTarget ? null : targetId;
  const activeChoices: TargetComboboxOption[] = options.data
    .filter((summary) => summary.archived_at == null)
    .map((summary) => ({ id: summary.id, name: summary.name, tier: summary.tier }));
  const detail = current.data;
  const singleChoices = [...activeChoices];
  if (detail !== undefined && !singleChoices.some((choice) => choice.id === detail.id)) {
    singleChoices.push({
      id: detail.id,
      name: detail.name,
      tier: detail.tier,
      archived: detail.archived_at != null,
    });
  }

  if (singleChoices.length === 0) {
    return canCreateTarget ? (
      <Button asChild variant="outline" size="sm" data-slot="target-switcher-create">
        <Link href={targetRoutes.create()}>
          <Plus aria-hidden="true" data-icon="inline-start" />
          Create a target
        </Link>
      </Button>
    ) : (
      <span data-slot="target-switcher-empty" className="text-sm text-muted-foreground">
        No targets yet
      </span>
    );
  }

  const selected = singleChoices.find((choice) => choice.id === activeTargetId);
  const triggerText =
    selected?.name ??
    (activeTargetId === null
      ? "Select a target"
      : current.isPending
        ? "Loading target"
        : "Unknown target");
  const multiple = mode === "multiple";
  const pickLimitReached = picked.length >= RUN_GROUP_MAX_TARGETS;
  const disabledIds =
    multiple && pickLimitReached
      ? activeChoices.map((choice) => choice.id).filter((id) => !picked.includes(id))
      : NO_IDS;
  const canStartGroup = canRunGroups && activeChoices.length >= RUN_GROUP_MIN_TARGETS;

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      setMode("single");
      setPicked(NO_IDS);
    }
  }

  function handlePick(pickedId: string): void {
    if (!multiple) {
      switchTarget(pickedId);
      handleOpenChange(false);
      return;
    }
    setPicked((previous) =>
      previous.includes(pickedId)
        ? previous.filter((id) => id !== pickedId)
        : [...previous, pickedId],
    );
  }

  function startMultiple(): void {
    setMode("multiple");
    setPicked(
      activeTargetId !== null && activeChoices.some((choice) => choice.id === activeTargetId)
        ? [activeTargetId]
        : NO_IDS,
    );
  }

  function openGroupDialog(): void {
    setGroupTargetIds(picked);
    handleOpenChange(false);
  }

  return (
    <div data-slot="target-switcher" className="flex min-w-0 items-center gap-2">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-slot="target-switcher-trigger"
            className="w-56 max-w-full justify-between"
          >
            <span className="sr-only">Current target: </span>
            <span className="min-w-0 flex-1 truncate text-left">{triggerText}</span>
            {selected === undefined ? null : <TierChip tier={selected.tier} />}
            <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" aria-label="Choose a target" className="w-80 gap-0 p-0">
          <TargetListbox
            key={mode}
            options={multiple ? activeChoices : singleChoices}
            selectedIds={
              multiple ? picked : activeTargetId === null ? NO_IDS : [activeTargetId]
            }
            multiple={multiple}
            onPick={handlePick}
            label={multiple ? "Targets for the run group" : "Targets"}
            disabledIds={disabledIds}
          />
          <div className="flex flex-col gap-2 border-t p-2">
            {multiple ? (
              <>
                <p role="status" className="text-xs text-muted-foreground">
                  {picked.length} selected. A run group needs at least {RUN_GROUP_MIN_TARGETS}{" "}
                  targets, up to {RUN_GROUP_MAX_TARGETS}.
                </p>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => setMode("single")}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={picked.length < RUN_GROUP_MIN_TARGETS}
                    onClick={openGroupDialog}
                  >
                    Choose plans for {picked.length}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-start"
                  disabled={!canStartGroup}
                  aria-describedby={canStartGroup ? undefined : hintId}
                  onClick={startMultiple}
                >
                  <Layers aria-hidden="true" data-icon="inline-start" />
                  Run on several targets
                </Button>
                {canStartGroup ? null : (
                  <p id={hintId} className="text-xs text-muted-foreground">
                    {canRunGroups
                      ? "A run group needs at least two targets."
                      : "Starting a run group needs the member role."}
                  </p>
                )}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {groupTargetIds === null ? null : (
        <RunGroupDialog
          open
          targetIds={groupTargetIds}
          onOpenChange={(next) => {
            if (!next) {
              setGroupTargetIds(null);
            }
          }}
        />
      )}
    </div>
  );
}
