"use client";

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { clientEnv } from "@/lib/env.client";

export const MARKETPLACE_NAME = "tessa";
export const PLUGIN_NAME = "tessa";
export const CONNECT_COMMAND = "/tessa:connect";
export const PLUGIN_SOURCE_MISSING_HINT =
  "Ask your Tessa admin for the plugin source; NEXT_PUBLIC_PLUGIN_SOURCE is not set on this deployment.";

export function marketplaceAddCommand(pluginSource: string | undefined): string {
  return `claude plugin marketplace add ${pluginSource ?? "<plugin source>"}`;
}

export function installCommand(): string {
  return `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
}

function CommandLine({ command, subject }: { command: string; subject: string }) {
  return (
    <div className="flex items-center gap-2">
      <code
        data-slot="connect-command"
        className="min-w-0 flex-1 rounded-md bg-muted px-3 py-2 font-mono text-xs break-all"
      >
        {command}
      </code>
      <CopyButton text={command} subject={subject} size="sm" />
    </div>
  );
}

export type ConnectPanelProps = {
  pluginSource?: string;
  apiUrl?: string;
  headingLevel?: 2 | 3;
  className?: string;
};

export function ConnectPanel({
  pluginSource = clientEnv.NEXT_PUBLIC_PLUGIN_SOURCE,
  apiUrl = clientEnv.NEXT_PUBLIC_API_URL,
  headingLevel = 2,
  className,
}: ConnectPanelProps) {
  return (
    <Card data-slot="connect-panel" className={className}>
      <CardHeader>
        <CardTitle role="heading" aria-level={headingLevel} className="flex items-center gap-2">
          <Terminal aria-hidden="true" className="size-4" />
          Connect Claude Code
        </CardTitle>
        <CardDescription>
          Three commands install the Tessa plugin. Claude Code then talks to Tessa with your
          personal token.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ol className="flex flex-col gap-4" aria-label="Connect steps">
          <li className="flex flex-col gap-2" data-step="marketplace">
            <p className="text-sm font-medium">1. Add the Tessa marketplace</p>
            <CommandLine
              command={marketplaceAddCommand(pluginSource)}
              subject="marketplace command"
            />
            {pluginSource === undefined ? (
              <p className="text-xs text-muted-foreground" data-slot="plugin-source-missing">
                {PLUGIN_SOURCE_MISSING_HINT}
              </p>
            ) : null}
          </li>
          <li className="flex flex-col gap-2" data-step="install">
            <p className="text-sm font-medium">2. Install the plugin</p>
            <CommandLine command={installCommand()} subject="install command" />
          </li>
          <li className="flex flex-col gap-2" data-step="connect">
            <p className="text-sm font-medium">
              3. Start Claude Code in your repository and connect
            </p>
            <CommandLine command={CONNECT_COMMAND} subject="connect command" />
          </li>
        </ol>
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1.5">
            <dt className="font-medium">API URL to paste when the plugin asks</dt>
            <dd>
              <CommandLine command={apiUrl} subject="API URL" />
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-medium">Token</dt>
            <dd className="text-muted-foreground">
              Paste the token when asked. Claude Code stores it in the operating system credential
              store, so it is never written to your repository or settings files.
            </dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="font-medium">On Windows</dt>
            <dd className="text-muted-foreground">
              Make sure <code className="font-mono text-xs">node</code> is on your PATH, and start
              Claude Code from the repository folder.
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
