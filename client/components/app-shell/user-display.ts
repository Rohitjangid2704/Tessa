export type ShellUser = {
  name: string | null;
  email: string;
};

const MAX_INITIALS = 2;

export function userDisplayName(user: ShellUser): string {
  const name = user.name?.trim();
  return name ? name : user.email;
}

export function userInitials(user: ShellUser): string {
  const name = user.name?.trim();
  const words = name ? name.split(/\s+/) : [user.email.split("@")[0] ?? ""];
  const initials = words
    .filter((word) => word.length > 0)
    .slice(0, MAX_INITIALS)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  return initials || "?";
}
