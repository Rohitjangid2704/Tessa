"use client";

import { Loader2, LogIn } from "lucide-react";
import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { clearToken } from "@/lib/auth/token-client";

export type SsoSignInProps = {
  action: (formData: FormData) => Promise<void>;
  callbackUrl: string;
  providerName: string;
};

function SsoSubmitButton({ providerName }: { providerName: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="lg" disabled={pending}>
      {pending ? (
        <>
          <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          Redirecting to {providerName}
        </>
      ) : (
        <>
          <LogIn aria-hidden="true" />
          Sign in with {providerName}
        </>
      )}
    </Button>
  );
}

export function SsoSignIn({ action, callbackUrl, providerName }: SsoSignInProps) {
  useEffect(() => {
    clearToken();
  }, []);

  return (
    <form action={action} className="flex flex-col gap-2" data-slot="sso-sign-in">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <SsoSubmitButton providerName={providerName} />
      <p className="text-xs text-muted-foreground">
        You sign in at your identity provider and return here. Signing out of Tessa does not end
        your {providerName} session.
      </p>
    </form>
  );
}
