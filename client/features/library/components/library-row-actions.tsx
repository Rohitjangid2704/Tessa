"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, GitCompare, Handshake } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortHash } from "@/features/bundles/format";
import { bundleVersionsOptions } from "@/features/bundles/queries";
import type { LibraryBundle } from "@/lib/api/types";
import { contractRoutes, targetRoutes, withQuery } from "@/lib/routes";

export function describeLibraryBundle(bundle: LibraryBundle): string {
  return `${bundle.target_name} version ${bundle.version}`;
}

export function bundleDiffHref(bundle: LibraryBundle, againstBundleId?: string) {
  return withQuery(targetRoutes.bundle(bundle.target_id, bundle.id), { against: againstBundleId });
}

function VersionChoices({ bundle }: { bundle: LibraryBundle }) {
  const versions = useInfiniteQuery(bundleVersionsOptions(bundle.target_id));
  const others = (versions.data?.items ?? []).filter((item) => item.id !== bundle.id);

  return (
    <>
      <DropdownMenuLabel>Compare {describeLibraryBundle(bundle)} with</DropdownMenuLabel>
      <DropdownMenuItem asChild>
        <Link href={bundleDiffHref(bundle)}>Previous valid version</Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {versions.isPending ? (
        <DropdownMenuItem disabled>Loading versions</DropdownMenuItem>
      ) : versions.isError ? (
        <DropdownMenuItem disabled>Could not load the other versions</DropdownMenuItem>
      ) : others.length === 0 ? (
        <DropdownMenuItem disabled>No other version of this target</DropdownMenuItem>
      ) : (
        others.map((item) => (
          <DropdownMenuItem key={item.id} asChild>
            <Link href={bundleDiffHref(bundle, item.id)}>
              <span>
                Version {item.version}
                {item.validation_status === "invalid" ? " (invalid)" : ""}
              </span>
              <code className="ml-auto font-mono text-xs text-muted-foreground">
                {shortHash(item.hash)}
              </code>
            </Link>
          </DropdownMenuItem>
        ))
      )}
    </>
  );
}

export function DiffAgainstMenu({ bundle }: { bundle: LibraryBundle }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Compare ${describeLibraryBundle(bundle)} with another version`}
        >
          <GitCompare aria-hidden="true" data-icon="inline-start" />
          Compare
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <VersionChoices bundle={bundle} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ContractRoleMenu({ bundle }: { bundle: LibraryBundle }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Use ${describeLibraryBundle(bundle)} in a contract check`}
        >
          <Handshake aria-hidden="true" data-icon="inline-start" />
          Use in contract
          <ChevronDown aria-hidden="true" data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem asChild>
          <Link href={contractRoutes.list({ consumer_bundle_id: bundle.id })}>Use as consumer</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={contractRoutes.list({ provider_bundle_id: bundle.id })}>Use as provider</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LibraryRowActions({ bundle }: { bundle: LibraryBundle }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button asChild variant="outline" size="sm">
        <Link
          href={targetRoutes.bundle(bundle.target_id, bundle.id)}
          aria-label={`Open ${describeLibraryBundle(bundle)}`}
        >
          Open
        </Link>
      </Button>
      <DiffAgainstMenu bundle={bundle} />
      <ContractRoleMenu bundle={bundle} />
    </div>
  );
}
