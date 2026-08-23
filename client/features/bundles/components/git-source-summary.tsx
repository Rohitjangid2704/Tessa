import { DateTime } from "@/components/date-time";
import type { BundleSource } from "@/lib/api/types";

export const SHORT_REF_LENGTH = 12;

export type GitSourceSummaryProps = {
  source: BundleSource;
};

export function shortGitRef(ref: string): string {
  return ref.length > SHORT_REF_LENGTH ? ref.slice(0, SHORT_REF_LENGTH) : ref;
}

export function GitSourceSummary({ source }: GitSourceSummaryProps) {
  return (
    <dl
      data-slot="git-source-summary"
      className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4"
    >
      <div className="flex min-w-0 flex-col">
        <dt className="text-muted-foreground">Repository</dt>
        <dd className="font-mono text-xs break-all">
          {source.git_url} <span className="text-muted-foreground">on</span> {source.branch}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-muted-foreground">Folder</dt>
        <dd className="font-mono text-xs">{source.path}</dd>
      </div>
      <div className="flex flex-col" data-slot="last-pulled">
        <dt className="text-muted-foreground">Last pulled</dt>
        <dd>
          <DateTime value={source.last_pulled_at} fallback="Never pulled" />
        </dd>
      </div>
      <div className="flex flex-col" data-slot="last-ref">
        <dt className="text-muted-foreground">Last ref</dt>
        <dd>
          {source.last_ref === null ? (
            <span className="text-muted-foreground">None yet</span>
          ) : (
            <code className="font-mono text-xs" title={source.last_ref}>
              {shortGitRef(source.last_ref)}
            </code>
          )}
        </dd>
      </div>
    </dl>
  );
}
