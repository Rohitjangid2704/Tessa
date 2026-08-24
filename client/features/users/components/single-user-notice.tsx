import { UserPlus } from "lucide-react";
import { SINGLE_USER_DESCRIPTION, SINGLE_USER_TITLE } from "../labels";

export function SingleUserNotice() {
  return (
    <section
      data-slot="single-user-notice"
      aria-label={SINGLE_USER_TITLE}
      className="flex items-start gap-3 rounded-xl border border-dashed p-4 text-sm"
    >
      <UserPlus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{SINGLE_USER_TITLE}</h2>
        <p className="text-muted-foreground">{SINGLE_USER_DESCRIPTION}</p>
      </div>
    </section>
  );
}
