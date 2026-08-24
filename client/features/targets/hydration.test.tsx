import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoleGate } from "@/components/role-gate";
import { TargetRequired } from "@/components/states/target-required";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiscoveryPromptPanel } from "@/features/prompts/components/discovery-prompt-panel";
import { meQuery } from "@/features/system/queries";
import { qk } from "@/lib/api/query-keys";
import { buildTarget, buildTargetSummary } from "@/mocks/factories/targets";
import { ADMIN_USER, toAuthUser } from "@/mocks/factories/users";
import { toAppKindList } from "@/mocks/fixtures/app-kinds";
import { STAGE_ONE_IDS } from "@/mocks/stage1/seed";
import { signInAs } from "@/tests/utils/api-session";
import { resetLocation } from "@/tests/utils/fake-navigation";
import { NewTargetButton } from "./components/new-target-button";
import { NewTargetWizard } from "./components/new-target-wizard";
import { TargetDangerZone } from "./components/target-danger-zone";
import { TargetFrame } from "./components/target-frame";
import { TargetOverview } from "./components/target-overview";
import { TargetSettingsCard } from "./components/target-settings-card";
import { TargetsList } from "./components/targets-list";
import { TokenCard } from "./components/token-card";
import { rememberTarget } from "./current-target";
import { targetsListQuery } from "./queries";
import { TargetSwitcher } from "./target-switcher";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

vi.mock("@/features/activity/use-agent-sessions-feed", () => ({
  useAgentSessionsFeed: () => undefined,
}));

vi.mock("next/navigation", async () => ({
  ...(await import("@/tests/utils/fake-navigation")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const TARGET = buildTarget({
  id: STAGE_ONE_IDS.gracie,
  name: "Gracie",
  app_kind: "llm_assistant",
  target_token: "tgt_graciedemotokenaaaaaaa",
});
const SUMMARY = buildTargetSummary({ id: TARGET.id, name: "Gracie", app_kind: "llm_assistant" });

function warmClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(qk.me(), toAuthUser(ADMIN_USER));
  client.setQueryData(qk.appKinds(), toAppKindList());
  client.setQueryData(qk.targets.detail(TARGET.id), TARGET);
  client.setQueryData(qk.targets.options(), {
    items: [SUMMARY],
    next_cursor: null,
    total: 1,
  });
  client.setQueryData(targetsListQuery({}).queryKey, {
    pages: [{ items: [SUMMARY], next_cursor: null, total: 1 }],
    pageParams: [null],
  });
  return client;
}

function coldClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
}

function tree(client: QueryClient, ui: ReactElement): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  );
}

interface Hydration {
  container: HTMLElement;
  errors: string[];
}

async function hydrateWithWarmCache(ui: ReactElement): Promise<Hydration> {
  const html = renderToString(tree(coldClient(), ui));
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const errors: string[] = [];
  const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  await act(async () => {
    hydrateRoot(container, tree(warmClient(), ui), {
      onRecoverableError: (error) => {
        errors.push(String(error));
      },
    });
  });
  logged.mockRestore();
  return { container, errors };
}

beforeEach(async () => {
  window.localStorage.clear();
  rememberTarget(null);
  resetLocation("/targets");
  await signInAs(ADMIN_USER);
});

afterEach(() => {
  document.body.innerHTML = "";
});

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes(name),
    ) ?? null
  );
}

describe("hydration with a warm query cache", () => {
  it("catches the bug it guards against: attributes from isPending stay stuck", async () => {
    function Naive() {
      const { isPending } = useQuery(meQuery());
      return <button disabled={isPending}>Naive</button>;
    }

    const { container, errors } = await hydrateWithWarmCache(<Naive />);

    expect(errors.length).toBeGreaterThan(0);
    expect(buttonNamed(container, "Naive")?.disabled).toBe(true);
  });

  it("RoleGate renders the same markup as the server and then reveals its content", async () => {
    const { container, errors } = await hydrateWithWarmCache(
      <RoleGate min="member">
        <button>Member only</button>
      </RoleGate>,
    );

    expect(errors).toEqual([]);
    expect(buttonNamed(container, "Member only")).not.toBeNull();
  });

  it("New target button", async () => {
    const { container, errors } = await hydrateWithWarmCache(<NewTargetButton />);

    expect(errors).toEqual([]);
    expect(container.querySelector("a")?.textContent).toContain("New target");
  });

  it("New target wizard", async () => {
    const { container, errors } = await hydrateWithWarmCache(<NewTargetWizard />);

    expect(errors).toEqual([]);
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("Discovery panel leaves Generate enabled once the role and hints are known", async () => {
    const { container, errors } = await hydrateWithWarmCache(
      <DiscoveryPromptPanel target={TARGET} />,
    );

    expect(errors).toEqual([]);
    expect(buttonNamed(container, "Generate Discovery prompt")?.disabled).toBe(false);
    expect(container.querySelectorAll("input[type=checkbox], button[role=checkbox]").length).toBe(
      3,
    );
  });

  it("token card keeps Rotate token enabled", async () => {
    const { container, errors } = await hydrateWithWarmCache(<TokenCard target={TARGET} />);

    expect(errors).toEqual([]);
    expect(buttonNamed(container, "Rotate token")?.disabled).toBe(false);
  });

  it("danger zone keeps Archive target enabled for an admin", async () => {
    const { container, errors } = await hydrateWithWarmCache(<TargetDangerZone target={TARGET} />);

    expect(errors).toEqual([]);
    expect(buttonNamed(container, "Archive target")?.disabled).toBe(false);
  });

  it("settings card keeps the name field and the production switch usable", async () => {
    const { container, errors } = await hydrateWithWarmCache(
      <TargetSettingsCard target={TARGET} />,
    );

    expect(errors).toEqual([]);
    expect(container.querySelector<HTMLInputElement>("#target-rename")?.disabled).toBe(false);
    expect(container.querySelector("#allow-production")).not.toBeNull();
  });

  it("target frame shows the target header from the cache", async () => {
    const { container, errors } = await hydrateWithWarmCache(
      <TargetFrame targetId={TARGET.id}>
        <p>page</p>
      </TargetFrame>,
    );

    expect(errors).toEqual([]);
    expect(container.querySelector("h1")?.textContent).toBe("Gracie");
  });

  it("target overview", async () => {
    const { container, errors } = await hydrateWithWarmCache(
      <TargetOverview targetId={TARGET.id} />,
    );

    expect(errors).toEqual([]);
    expect(buttonNamed(container, "Generate Discovery prompt")?.disabled).toBe(false);
    expect(buttonNamed(container, "Rotate token")?.disabled).toBe(false);
  });

  it("targets list", async () => {
    const { container, errors } = await hydrateWithWarmCache(<TargetsList />);

    expect(errors).toEqual([]);
    expect(container.querySelector("tbody a")?.textContent).toBe("Gracie");
  });

  it("target switcher", async () => {
    resetLocation(`/targets/${TARGET.id}`);

    const { container, errors } = await hydrateWithWarmCache(<TargetSwitcher />);

    expect(errors).toEqual([]);
    expect(container.querySelector("[role=combobox]")?.textContent).toContain("Gracie");
  });

  it("target required", async () => {
    const { container, errors } = await hydrateWithWarmCache(<TargetRequired />);

    expect(errors).toEqual([]);
    expect(container.querySelector("[role=combobox]")).not.toBeNull();
  });
});

describe("the same trees with a cold cache", () => {
  it("hydrate without any mismatch", async () => {
    const ui = (
      <>
        <NewTargetButton />
        <TokenCard target={TARGET} />
        <DiscoveryPromptPanel target={TARGET} />
      </>
    );
    const html = renderToString(tree(coldClient(), ui));
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors: string[] = [];
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    await act(async () => {
      hydrateRoot(container, tree(coldClient(), ui), {
        onRecoverableError: (error) => {
          errors.push(String(error));
        },
      });
    });
    logged.mockRestore();

    expect(errors).toEqual([]);
  });
});
