import { describe, expect, it } from "vitest";
import { userDisplayName, userInitials } from "./user-display";

describe("userDisplayName", () => {
  it("prefers the name and falls back to the email", () => {
    expect(userDisplayName({ name: "Ada Lovelace", email: "ada@tessa.local" })).toBe(
      "Ada Lovelace",
    );
    expect(userDisplayName({ name: "  ", email: "ada@tessa.local" })).toBe(
      "ada@tessa.local",
    );
    expect(userDisplayName({ name: null, email: "ada@tessa.local" })).toBe(
      "ada@tessa.local",
    );
  });
});

describe("userInitials", () => {
  it("uses the first letters of up to two words of the name", () => {
    expect(userInitials({ name: "Ada Lovelace", email: "x@y.z" })).toBe("AL");
    expect(userInitials({ name: "ada king lovelace", email: "x@y.z" })).toBe("AK");
    expect(userInitials({ name: "Admin", email: "admin@tessa.local" })).toBe("A");
  });

  it("falls back to the local part of the email", () => {
    expect(userInitials({ name: null, email: "grace@tessa.local" })).toBe("G");
  });

  it("never returns an empty string", () => {
    expect(userInitials({ name: null, email: "@tessa.local" })).toBe("?");
  });
});
