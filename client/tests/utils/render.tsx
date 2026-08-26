import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import type { ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface ProvidersOptions {
  queryClient?: QueryClient;
  theme?: "light" | "dark";
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

export function renderWithProviders(
  ui: ReactElement,
  {
    queryClient = createTestQueryClient(),
    theme = "light",
    ...renderOptions
  }: ProvidersOptions & Omit<RenderOptions, "wrapper"> = {},
): RenderWithProvidersResult {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <ThemeProvider attribute="class" defaultTheme={theme} enableSystem={false}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>{children}</TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  return { ...render(ui, { wrapper: Wrapper, ...renderOptions }), queryClient };
}

export { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
