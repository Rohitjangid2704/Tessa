export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { getServerEnv } = await import("@/lib/env.server");
  await import("@/lib/env.client");
  getServerEnv();
}
