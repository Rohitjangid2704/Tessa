import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const MAX_REPORTED_TARGETS = 3;

export interface AxeOptions {
  include?: string;
  exclude?: string[];
  disableRules?: string[];
}

export async function expectNoAxeViolations(page: Page, options: AxeOptions = {}): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.include !== undefined) {
    builder = builder.include(options.include);
  }
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }
  if (options.disableRules !== undefined) {
    builder = builder.disableRules(options.disableRules);
  }
  const { violations } = await builder.analyze();
  const summary = violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.length,
    targets: violation.nodes.slice(0, MAX_REPORTED_TARGETS).map((node) => node.target.join(" ")),
  }));
  expect(summary).toEqual([]);
}
