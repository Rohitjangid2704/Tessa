export interface CoverageAccess {
  canGenerate: boolean;
  canAuthor: boolean;
  productionTarget: boolean;
}

export const VIEWER_REASON = "Needs the member role. Ask an admin to change your role.";

export const PRODUCTION_GENERATE_REASON =
  "production_blocked: this is a production target, so scenarios are not generated here. Copy the Author prompt to write them with Claude Code instead.";

export function generateBlockedReason(access: CoverageAccess): string | null {
  if (!access.canGenerate) {
    return VIEWER_REASON;
  }
  return access.productionTarget ? PRODUCTION_GENERATE_REASON : null;
}

export function authorBlockedReason(access: CoverageAccess): string | null {
  return access.canAuthor ? null : VIEWER_REASON;
}
