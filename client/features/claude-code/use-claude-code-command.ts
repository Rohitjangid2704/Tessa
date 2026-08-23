import { useMemo } from "react";

export const MAX_AUTHOR_CELL_IDS = 20;

export const AUTHOR_SELECTION_NOTE =
  "More than 20 cells: run /tessa:author and pick the cells in the coverage selection.";

export const AUTHOR_ITEM_SELECTION_NOTE =
  "More than 20 items: run /tessa:author and it reads the selection from the open proposal.";

export type ClaudeCodeTemplate =
  "discover" | "explain" | "author" | "mutants" | "hooks" | "propose";

export type ClaudeCodeParams = {
  discover: { target_token: string };
  explain: { finding_id: string };
  author: { cell_ids?: readonly string[]; item_ids?: readonly string[] };
  mutants: undefined;
  hooks: undefined;
  propose: undefined;
};

export type ClaudeCodeCommandResult = {
  command: string;
  note: string | null;
};

const COMMAND_PREFIX = "/tessa:";

function withArgument(template: ClaudeCodeTemplate, argument: string): ClaudeCodeCommandResult {
  const name = `${COMMAND_PREFIX}${template}`;
  const trimmed = argument.trim();
  return { command: trimmed === "" ? name : `${name} ${trimmed}`, note: null };
}

const BUILDERS: {
  [Template in ClaudeCodeTemplate]: (
    params: ClaudeCodeParams[Template] | undefined,
  ) => ClaudeCodeCommandResult;
} = {
  discover: (params) => withArgument("discover", params?.target_token ?? ""),
  explain: (params) => withArgument("explain", params?.finding_id ?? ""),
  author: (params) => {
    const itemIds = params?.item_ids ?? [];
    if (itemIds.length > MAX_AUTHOR_CELL_IDS) {
      return { command: `${COMMAND_PREFIX}author`, note: AUTHOR_ITEM_SELECTION_NOTE };
    }
    if (itemIds.length > 0) {
      return withArgument("author", itemIds.join(","));
    }
    const cellIds = params?.cell_ids ?? [];
    if (cellIds.length > MAX_AUTHOR_CELL_IDS) {
      return { command: `${COMMAND_PREFIX}author`, note: AUTHOR_SELECTION_NOTE };
    }
    return withArgument("author", cellIds.join(","));
  },
  mutants: () => withArgument("mutants", ""),
  hooks: () => withArgument("hooks", ""),
  propose: () => withArgument("propose", ""),
};

export function buildClaudeCodeCommand<Template extends ClaudeCodeTemplate>(
  template: Template,
  params?: ClaudeCodeParams[Template],
): ClaudeCodeCommandResult {
  return BUILDERS[template](params);
}

export function useClaudeCodeCommand<Template extends ClaudeCodeTemplate>(
  template: Template,
  params?: ClaudeCodeParams[Template],
): ClaudeCodeCommandResult {
  return useMemo(() => buildClaudeCodeCommand(template, params), [template, params]);
}
