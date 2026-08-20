import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";
import { decideGate } from "./gate";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

const base = { search: "", callbackUrl: null };

describe("decideGate", () => {
  it("lets authenticated visitors through", () => {
    expect(decideGate({ ...base, pathname: "/runs", isAuthenticated: true })).toEqual({
      action: "next",
    });
  });

  it("sends anonymous visitors to login and keeps where they were going", () => {
    expect(
      decideGate({ ...base, pathname: "/runs", search: "?tab=events", isAuthenticated: false }),
    ).toEqual({
      action: "redirect",
      location: "/login?callbackUrl=%2Fruns%3Ftab%3Devents",
    });
  });

  it("does not add a callback for the home page", () => {
    expect(decideGate({ ...base, pathname: "/", isAuthenticated: false })).toEqual({
      action: "redirect",
      location: "/login",
    });
  });

  it("serves the login page to anonymous visitors", () => {
    expect(decideGate({ ...base, pathname: "/login", isAuthenticated: false })).toEqual({
      action: "next",
    });
  });

  it("sends signed-in visitors on the login page home", () => {
    expect(decideGate({ ...base, pathname: "/login", isAuthenticated: true })).toEqual({
      action: "redirect",
      location: "/",
    });
  });

  it("sends signed-in visitors on the login page to a safe callback", () => {
    expect(
      decideGate({
        pathname: "/login",
        search: "?callbackUrl=%2Fruns",
        isAuthenticated: true,
        callbackUrl: "/runs",
      }),
    ).toEqual({ action: "redirect", location: "/runs" });
  });

  it("ignores an unsafe callback", () => {
    expect(
      decideGate({
        pathname: "/login",
        search: "",
        isAuthenticated: true,
        callbackUrl: "//evil.example",
      }),
    ).toEqual({ action: "redirect", location: "/" });
  });
});

describe("proxy matcher", () => {
  async function matches(url: string) {
    const { config } = await import("@/proxy");
    return unstable_doesMiddlewareMatch({ config, url });
  }

  it.each([
    "/",
    "/login",
    "/runs",
    "/runs/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e11",
    "/dev/hello",
    "/settings?tab=x",
  ])("runs for the page %s", async (url) => {
    await expect(matches(url)).resolves.toBe(true);
  });

  it.each([
    "/api/auth/session",
    "/api/auth/callback/credentials",
    "/api/session/api-token",
    "/_next/static/chunks/app.js",
    "/_next/image?url=%2Fa.png&w=64&q=75",
    "/favicon.ico",
    "/logo.svg",
    "/fonts/geist.woff2",
    "/robots.txt",
  ])("skips %s", async (url) => {
    await expect(matches(url)).resolves.toBe(false);
  });
});
