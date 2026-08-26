import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { countRowsContaining } from "./postgres";
import { serverLogFiles } from "./stack";

export interface TrafficRecorder {
  responseBodies: () => Promise<{ url: string; text: string }[]>;
  requestUrls: () => string[];
}

export function recordTraffic(page: Page): TrafficRecorder {
  const pending: Promise<{ url: string; text: string }>[] = [];
  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  page.on("response", (response) => {
    pending.push(
      response
        .text()
        .catch(() => "")
        .then((text) => ({ url: response.url(), text })),
    );
  });
  return { responseBodies: () => Promise.all(pending), requestUrls: () => [...urls] };
}

async function browserHoldings(page: Page): Promise<{
  inputValues: string[];
  storage: string;
}> {
  return page.evaluate(() => ({
    inputValues: Array.from(document.querySelectorAll("input, textarea")).map(
      (element) => (element as HTMLInputElement).value,
    ),
    storage: JSON.stringify([
      Object.entries(window.localStorage),
      Object.entries(window.sessionStorage),
      document.cookie,
    ]),
  }));
}

export async function expectNoSecretInBrowser(page: Page, secrets: string[]): Promise<void> {
  const holdings = await browserHoldings(page);
  const html = await page.content();
  const text = await page.locator("body").innerText();
  for (const secret of secrets) {
    expect(text.includes(secret), "visible text").toBe(false);
    expect(html.includes(secret), "page HTML").toBe(false);
    expect(
      holdings.inputValues.filter((value) => value.includes(secret)),
      "input values",
    ).toEqual([]);
    expect(holdings.storage.includes(secret), "browser storage").toBe(false);
  }
}

export async function expectNoSecretInTraffic(
  recorder: TrafficRecorder,
  secrets: string[],
): Promise<number> {
  const bodies = await recorder.responseBodies();
  for (const secret of secrets) {
    expect(
      bodies.filter((body) => body.text.includes(secret)).map((body) => body.url),
      "response bodies holding a secret",
    ).toEqual([]);
    expect(
      recorder.requestUrls().filter((url) => url.includes(secret)),
      "request URLs holding a secret",
    ).toEqual([]);
  }
  return bodies.length;
}

export function expectNoSecretInServerLogs(secrets: string[]): {
  files: number;
  characters: number;
} {
  const files = serverLogFiles();
  let characters = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    characters += text.length;
    for (const secret of secrets) {
      expect(text.includes(secret), `log file ${file}`).toBe(false);
    }
  }
  return { files: files.length, characters };
}

export function expectNoPlaintextInVault(targetId: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(countRowsContaining(targetId, secret), "environment rows holding the plaintext").toBe(0);
  }
}
