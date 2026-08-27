const AFFECTED_MAJORS = new Set([23, 25]);
const FIXED_IN_24 = 20;

export function hasWindowsAbortBug(nodeVersion: string, platform: string): boolean {
  if (platform !== "win32") {
    return false;
  }
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, "").split(".").map(Number);
  return AFFECTED_MAJORS.has(major) || (major === 24 && minor < FIXED_IN_24);
}

export function runtimeAdvisory(nodeVersion: string, platform: string): string | null {
  if (!hasWindowsAbortBug(nodeVersion, platform)) {
    return null;
  }
  return `Node ${nodeVersion} on Windows can abort the tessa MCP server with exit code 3221226505 (a libuv assertion fixed in Node 24.20.0, nodejs/node#61999); its tools then fail with "Connection closed". Upgrade Node to 24.20.0 or later.`;
}
