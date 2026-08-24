import type { StepTool } from "@/lib/api/types";
import { JsonView } from "./json-view";
import { StepSection } from "./step-section";

function ToolItem({ tool }: { tool: StepTool }) {
  const hasArgs = Object.keys(tool.args).length > 0;
  return (
    <li data-slot="tool-item" className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <code className="font-mono text-sm font-medium wrap-anywhere">{tool.name}</code>
        {tool.result_summary === null ? null : (
          <span className="text-sm wrap-anywhere text-muted-foreground">{tool.result_summary}</span>
        )}
      </div>
      {hasArgs ? (
        <JsonView value={tool.args} label={`Arguments of ${tool.name}`} defaultOpenDepth={1} />
      ) : (
        <p className="text-xs text-muted-foreground">This call had no arguments.</p>
      )}
    </li>
  );
}

export function ToolsList({ tools }: { tools: readonly StepTool[] }) {
  if (tools.length === 0) {
    return null;
  }
  return (
    <StepSection title="Tools called">
      <ol data-slot="tools-list" className="flex flex-col gap-2">
        {tools.map((tool, index) => (
          <ToolItem key={`${tool.name}:${index}`} tool={tool} />
        ))}
      </ol>
    </StepSection>
  );
}
