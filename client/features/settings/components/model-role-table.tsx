"use client";

import { Cpu } from "lucide-react";
import type { SettingsRead } from "@/lib/api/types";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { findLeafSpec, MODEL_ROLE_LABELS, MODEL_ROLES } from "../schemas";
import { LeafControl, LeafMessage, LeafReset, SourceBadge } from "./leaf-controls";
import { SettingsSection, type SectionApi } from "./settings-section";

export interface ModelRoleTableProps {
  settings: SettingsRead;
  readOnly: boolean;
}

const MODEL_COLUMNS = [
  { leaf: "model", header: "Model", className: "min-w-44" },
  { leaf: "effort", header: "Effort", className: "min-w-32" },
  { leaf: "max_usd", header: "Max USD", className: "min-w-24" },
  { leaf: "timeout_seconds", header: "Timeout (s)", className: "min-w-24" },
] as const;

function ModelRows({ api }: { api: SectionApi }) {
  return (
    <Table>
      <TableCaption className="sr-only">Model, effort, cost cap and timeout per role</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Role</TableHead>
          {MODEL_COLUMNS.map((column) => (
            <TableHead key={column.leaf}>{column.header}</TableHead>
          ))}
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {MODEL_ROLES.map((role) => {
          const source = api.settings.models[role]?.source ?? "env";
          return (
            <TableRow key={role} data-role={role} data-source={source}>
              <TableCell className="font-medium">{MODEL_ROLE_LABELS[role]}</TableCell>
              {MODEL_COLUMNS.map((column) => {
                const spec = findLeafSpec("models", role, column.leaf);
                return (
                  <TableCell key={column.leaf} className={`${column.className} align-top`}>
                    <div className="flex flex-col gap-1">
                      <LeafControl api={api} spec={spec} label={spec.label} />
                      <LeafMessage api={api} spec={spec} />
                      <LeafReset api={api} spec={spec} compact />
                    </div>
                  </TableCell>
                );
              })}
              <TableCell className="align-top">
                <SourceBadge source={source} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function ModelRoleTable({ settings, readOnly }: ModelRoleTableProps) {
  return (
    <SettingsSection
      group="models"
      title="Models and effort"
      description="Which model each role calls, how hard it thinks, and its cost and time caps. The name is free text; the API says when it does not accept one."
      icon={Cpu}
      settings={settings}
      readOnly={readOnly}
    >
      {(api) => <ModelRows api={api} />}
    </SettingsSection>
  );
}
