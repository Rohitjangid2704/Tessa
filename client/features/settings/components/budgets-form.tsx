"use client";

import { Wallet } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import type { SettingsRead } from "@/lib/api/types";
import { findLeafSpec } from "../schemas";
import { LeafField } from "./leaf-controls";
import { SettingsSection } from "./settings-section";

export interface BudgetsFormProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const BUDGET_FIELDS = [
  {
    leaf: "default_max_usd",
    description: "The cost cap a run gets when the plan sets none, in USD.",
  },
  {
    leaf: "default_max_minutes",
    description: "The time cap a run gets when the plan sets none, in whole minutes.",
  },
  {
    leaf: "max_concurrency",
    description: "How many scenarios one run executes at once.",
  },
] as const;

export function BudgetsForm({ settings, readOnly }: BudgetsFormProps) {
  return (
    <SettingsSection
      group="budgets"
      title="Budgets"
      description="Defaults the server applies when a plan or run does not set its own."
      icon={Wallet}
      settings={settings}
      readOnly={readOnly}
    >
      {(api) => (
        <FieldGroup>
          {BUDGET_FIELDS.map((field) => (
            <LeafField
              key={field.leaf}
              api={api}
              spec={findLeafSpec("budgets", field.leaf)}
              description={field.description}
            />
          ))}
        </FieldGroup>
      )}
    </SettingsSection>
  );
}
