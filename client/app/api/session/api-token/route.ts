import { getSessionUser } from "@/lib/auth/dal";
import { mintApiToken } from "@/lib/auth/api-token";
import { getServerEnv } from "@/lib/env.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json(
      {
        error: {
          code: "unauthenticated",
          message: "Authentication required",
          request_id: crypto.randomUUID(),
          details: [],
        },
      },
      { status: 401, headers: NO_STORE },
    );
  }
  const minted = await mintApiToken(
    { id: user.id, email: user.email, role: user.role },
    getServerEnv(),
  );
  return Response.json(minted, { headers: NO_STORE });
}
