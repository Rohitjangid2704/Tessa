import { z } from "zod";
import type { BundleImportCreate, BundleSource, BundleSourceSet } from "@/lib/api/types";

export const GIT_URL_MAX_LENGTH = 2048;
export const GIT_BRANCH_MAX_LENGTH = 255;
export const GIT_PATH_MAX_LENGTH = 255;
export const GIT_REF_MAX_LENGTH = 255;
export const CREDENTIAL_NAME_MAX_LENGTH = 200;
export const DEFAULT_GIT_BRANCH = "main";
export const DEFAULT_GIT_PATH = "tessa/";

export const GIT_URL_NOT_HTTPS_MESSAGE = "The URL must be an https:// address";
export const GIT_URL_USERINFO_MESSAGE =
  "Remove the username and password from the URL. Choose the credential below instead.";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isHttpsGitUrl(value: string): boolean {
  return parseUrl(value)?.protocol === "https:";
}

export function hasGitUrlUserinfo(value: string): boolean {
  const url = parseUrl(value);
  return url !== null && (url.username !== "" || url.password !== "");
}

function isRelativeSourcePath(value: string): boolean {
  return !value.startsWith("/") && !value.split("/").includes("..");
}

export const bundleSourceSchema = z.object({
  git_url: z
    .string()
    .trim()
    .min(1, "Enter the repository URL")
    .max(GIT_URL_MAX_LENGTH, `Use at most ${GIT_URL_MAX_LENGTH} characters`)
    .refine((value) => value === "" || isHttpsGitUrl(value), GIT_URL_NOT_HTTPS_MESSAGE)
    .refine((value) => !hasGitUrlUserinfo(value), GIT_URL_USERINFO_MESSAGE),
  branch: z
    .string()
    .trim()
    .min(1, "Enter a branch")
    .max(GIT_BRANCH_MAX_LENGTH, `Use at most ${GIT_BRANCH_MAX_LENGTH} characters`)
    .refine((value) => !/\s/.test(value), "A branch name has no spaces"),
  path: z
    .string()
    .trim()
    .max(GIT_PATH_MAX_LENGTH, `Use at most ${GIT_PATH_MAX_LENGTH} characters`)
    .refine(isRelativeSourcePath, "Use a path inside the repository, without a leading / or .."),
  credential_name: z
    .string()
    .min(1, "Choose the credential variable")
    .max(CREDENTIAL_NAME_MAX_LENGTH, `Use at most ${CREDENTIAL_NAME_MAX_LENGTH} characters`),
});

export type BundleSourceFormValues = z.infer<typeof bundleSourceSchema>;

export const BUNDLE_SOURCE_FIELDS = ["git_url", "branch", "path", "credential_name"] as const;

export function emptyBundleSourceForm(): BundleSourceFormValues {
  return { git_url: "", branch: DEFAULT_GIT_BRANCH, path: DEFAULT_GIT_PATH, credential_name: "" };
}

export function bundleSourceFormValues(
  source: BundleSource | null | undefined,
): BundleSourceFormValues {
  if (source === null || source === undefined) {
    return emptyBundleSourceForm();
  }
  return {
    git_url: source.git_url,
    branch: source.branch,
    path: source.path,
    credential_name: source.credential_name,
  };
}

export function toBundleSourceSet(values: BundleSourceFormValues): BundleSourceSet {
  const path = values.path.trim();
  return {
    git_url: values.git_url.trim(),
    branch: values.branch.trim(),
    credential_name: values.credential_name,
    ...(path === "" ? {} : { path }),
  };
}

export const pullRefSchema = z.object({
  ref: z.string().trim().max(GIT_REF_MAX_LENGTH, `Use at most ${GIT_REF_MAX_LENGTH} characters`),
});

export type PullRefFormValues = z.infer<typeof pullRefSchema>;

export function toBundleImportCreate(values: PullRefFormValues): BundleImportCreate {
  const ref = values.ref.trim();
  return ref === "" ? {} : { ref };
}
