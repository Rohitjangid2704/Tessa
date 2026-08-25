import type { AuthUser, MockUser } from "../types";

export const ADMIN_USER: MockUser = {
  id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e01",
  email: "admin@tessa.local",
  name: "Admin",
  role: "admin",
  password: "dev-only-admin-password-1",
  isActive: true,
};

export const MEMBER_USER: MockUser = {
  id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e02",
  email: "member@tessa.local",
  name: "Member",
  role: "member",
  password: "dev-only-member-password-1",
  isActive: true,
};

export const VIEWER_USER: MockUser = {
  id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e03",
  email: "viewer@tessa.local",
  name: "Viewer",
  role: "viewer",
  password: "dev-only-viewer-password-1",
  isActive: true,
};

export const INACTIVE_USER: MockUser = {
  id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b8e04",
  email: "inactive@tessa.local",
  name: "Inactive",
  role: "member",
  password: "dev-only-inactive-password-1",
  isActive: false,
};

export function createSeedUsers(): MockUser[] {
  return [ADMIN_USER, MEMBER_USER, VIEWER_USER, INACTIVE_USER].map((user) => ({ ...user }));
}

export function toAuthUser(user: MockUser): AuthUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
