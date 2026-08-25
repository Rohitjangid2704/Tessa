import { createSeedUsers } from "../factories/users";
import { mockState, type MockState } from "../state";
import type { MockUser } from "../types";
import {
  defaultAccounts,
  manyAccounts,
  singleAccount,
  type SeededAccount,
  type UserProfile,
} from "./users-data";

export const USERS_VARIANTS = ["default", "single", "many"] as const;

export type UsersVariant = (typeof USERS_VARIANTS)[number];

const ACCOUNTS_BY_VARIANT: Record<UsersVariant, () => SeededAccount[]> = {
  default: defaultAccounts,
  single: singleAccount,
  many: manyAccounts,
};

export class UsersStore {
  private variant: UsersVariant = "default";
  private ready = false;
  private readonly profiles = new Map<string, UserProfile>();

  get currentVariant(): UsersVariant {
    return this.variant;
  }

  load(variant: UsersVariant, state: MockState): void {
    const accounts = ACCOUNTS_BY_VARIANT[variant]();
    this.profiles.clear();
    for (const { user, profile } of accounts) {
      this.profiles.set(user.id, profile);
    }
    state.users = accounts.map(({ user }) => user);
    this.variant = variant;
    this.ready = true;
  }

  ensure(state: MockState): void {
    if (!this.ready) {
      this.load("default", state);
    }
  }

  profileOf(userId: string): UserProfile {
    const existing = this.profiles.get(userId);
    if (existing !== undefined) {
      return existing;
    }
    const created: UserProfile = {
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      teamIds: [],
    };
    this.profiles.set(userId, created);
    return created;
  }

  add(state: MockState, user: MockUser, profile: UserProfile): void {
    state.users.push(user);
    this.profiles.set(user.id, profile);
  }

  setTeamIds(userId: string, teamIds: readonly string[]): void {
    this.profileOf(userId).teamIds = [...new Set(teamIds)];
  }

  replaceTeamMembers(teamId: string, userIds: readonly string[]): void {
    const members = new Set(userIds);
    for (const [userId, profile] of this.profiles) {
      const others = profile.teamIds.filter((existing) => existing !== teamId);
      profile.teamIds = members.has(userId) ? [...others, teamId] : others;
    }
  }

  memberIdsOf(teamId: string): string[] {
    return [...this.profiles]
      .filter(([, profile]) => profile.teamIds.includes(teamId))
      .map(([userId]) => userId);
  }

  reset(): void {
    this.variant = "default";
    this.ready = false;
    this.profiles.clear();
    mockState.users = createSeedUsers();
  }
}

export const usersStore = new UsersStore();

mockState.stageTwo.onReset(() => usersStore.reset());
