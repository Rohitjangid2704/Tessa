"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { settingsRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { ConnectPanel, type ConnectPanelProps } from "./connect-panel";

export const CONNECT_SECTION_LABEL = "Run it in Claude Code instead";

export function ConnectPanelSection(props: Omit<ConnectPanelProps, "headingLevel">) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="connect-panel-section">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          <ChevronDown
            aria-hidden="true"
            data-icon="inline-start"
            className={cn("transition-transform", open ? "rotate-0" : "-rotate-90")}
          />
          {CONNECT_SECTION_LABEL}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">
        <p className="text-sm text-muted-foreground">
          The plugin runs the same Discovery prompt for you and uploads the bundle. You need a
          personal token first:{" "}
          <Link href={settingsRoutes.tokens()} className="underline underline-offset-3">
            create one in Settings
          </Link>
          .
        </p>
        <ConnectPanel {...props} headingLevel={3} />
      </CollapsibleContent>
    </Collapsible>
  );
}
