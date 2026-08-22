import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { describeLoginNotice, type LoginNoticeCode } from "@/lib/auth/login-notices";

export type LoginNoticeProps = {
  code: LoginNoticeCode;
  passwordAvailable: boolean;
};

export function LoginNotice({ code, passwordAvailable }: LoginNoticeProps) {
  const { title, description } = describeLoginNotice(code, { passwordAvailable });
  return (
    <Alert variant="destructive" data-notice={code}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}

export function ReturnPathNote({ path }: { path: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground" data-slot="return-path-note">
      Sign in to continue to{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-all">{path}</code>. You
      return there after signing in.
    </p>
  );
}

export function SignInDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
  );
}
