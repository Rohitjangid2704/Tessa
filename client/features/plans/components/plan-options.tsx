"use client";

import type { Dispatch } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CatalogInterface, CatalogRole } from "@/features/catalog/types";
import type { BudgetFieldErrors } from "../budget-input";
import { interfaceCapabilities, resolveInterfaceMode } from "../plan-selection";
import type { PlanFieldErrors } from "../run-errors";
import type { PlanBuilderAction, PlanBuilderState } from "../selection-reducer";
import type { Budget } from "../types";
import { ApiFuzzToggle } from "./api-fuzz-toggle";
import { AttemptsStepper } from "./attempts-stepper";
import { BudgetFields } from "./budget-fields";
import { DepthPicker } from "./depth-picker";
import { InterfaceModePicker } from "./interface-mode-picker";
import { ResetSeedToggle } from "./reset-seed-toggle";
import { RolePicker } from "./role-picker";

export interface PlanOptionsProps {
  state: PlanBuilderState;
  dispatch: Dispatch<PlanBuilderAction>;
  roles: readonly CatalogRole[];
  interfaces: readonly CatalogInterface[];
  budgetPlaceholders: Budget | null;
  budgetErrors: BudgetFieldErrors;
  serverErrors: PlanFieldErrors;
  productionTarget: boolean;
  disabled?: boolean;
}

export function PlanOptions({
  state,
  dispatch,
  roles,
  interfaces,
  budgetPlaceholders,
  budgetErrors,
  serverErrors,
  productionTarget,
  disabled = false,
}: PlanOptionsProps) {
  const capabilities = interfaceCapabilities(interfaces);
  const interfaceMode = resolveInterfaceMode(state.interfaceMode, capabilities);

  return (
    <Card role="region" aria-label="Run options" data-slot="plan-options">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Run options
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <RolePicker
          roles={roles}
          value={state.roleIds}
          disabled={disabled}
          onChange={(roleIds) => dispatch({ type: "set_roles", roleIds })}
        />
        <InterfaceModePicker
          value={interfaceMode}
          capabilities={capabilities}
          disabled={disabled}
          onChange={(mode) => dispatch({ type: "set_interface_mode", mode })}
        />
        <DepthPicker
          value={state.depth}
          error={serverErrors.depth}
          disabled={disabled}
          onChange={(depth) => dispatch({ type: "set_depth", depth })}
        />
        <ApiFuzzToggle
          checked={state.includeApiFuzz}
          disabled={disabled}
          onCheckedChange={(value) => dispatch({ type: "set_api_fuzz", value })}
        />
        <AttemptsStepper
          value={state.k}
          error={serverErrors.k}
          disabled={disabled}
          onChange={(k) => dispatch({ type: "set_attempts", k })}
        />
        <BudgetFields
          maxUsd={state.maxUsd}
          maxMinutes={state.maxMinutes}
          placeholders={budgetPlaceholders}
          errors={{
            max_usd: budgetErrors.max_usd ?? serverErrors.max_usd,
            max_minutes: budgetErrors.max_minutes ?? serverErrors.max_minutes,
          }}
          disabled={disabled}
          onMaxUsdChange={(value) => dispatch({ type: "set_max_usd", value })}
          onMaxMinutesChange={(value) => dispatch({ type: "set_max_minutes", value })}
        />
        <ResetSeedToggle
          checked={state.resetSeed}
          productionTarget={productionTarget}
          disabled={disabled}
          onCheckedChange={(value) => dispatch({ type: "set_reset_seed", value })}
        />
      </CardContent>
    </Card>
  );
}
