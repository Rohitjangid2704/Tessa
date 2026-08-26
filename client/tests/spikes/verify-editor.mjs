import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const [key, ...rest] = argument.replace(/^--/, "").split("=");
    return [key, rest.join("=") || "true"];
  }),
);

const baseUrl = options.url ?? "http://localhost:3000";
const editorPath = options.path ?? "/dev/editor";
const email = options.email ?? process.env.E2E_USER_EMAIL ?? "admin@tessa.local";
const password = options.password ?? process.env.E2E_USER_PASSWORD ?? "dev-only-admin-password-1";
const apiOrigin = options.api ?? "http://localhost:8000";
const cspMode = options.csp ?? "none";
const isDevelopmentServer = options.dev === "true";

const VALID_FLOW_YAML =
  "{target_token: tgt_ABCDEFGHIJKLMNOPQRSTUV, app: {name: Gracie, summary: Staff assistant, kind: api}, interfaces: [{id: http_api, kind: http}], features: [{id: smart_log.read.open, area: Smart Log, kind: read, description: Open issues, interfaces: [http_api], roles: [all], examples: [{expected: a count}]}]}";
const SCHEMA_INVALID_FLOW_YAML = "{app: {name: Gracie, kind: spaceship}, features: oops}";
const SYNTAX_INVALID_YAML = "app: [unclosed";

const policies = {
  none: null,
  strict: [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevelopmentServer ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin} ws:`,
    "worker-src 'self'",
  ].join("; "),
  minimal: [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin} ws:`,
    "worker-src 'self'",
  ].join("; "),
  strictWithBlobWorkers: [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevelopmentServer ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin} ws:`,
    "worker-src 'self' blob:",
  ].join("; "),
};

function bytesToKb(bytes) {
  return Math.round((bytes / 1024) * 10) / 10;
}

async function waitForMarkerCount(page, predicate, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const count = Number(
      await page.getByTestId("marker-count").getAttribute("data-count", { timeout: 2000 }),
    );
    if (predicate(count)) {
      return count;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function replaceEditorText(page, text, mode) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  if (mode === "insert") {
    await page.keyboard.insertText(text);
  } else {
    await page.keyboard.type(text, { delay: 4 });
  }
}

async function readMarkers(page) {
  return page.getByTestId("marker-list").locator("li").allInnerTexts();
}

const browser = await chromium.launch({
  args: cspMode === "none" ? [] : ["--disable-features=LocalNetworkAccessChecks"],
});
const policy = policies[cspMode];
if (policy === undefined) {
  throw new Error(`unknown csp mode ${cspMode}`);
}

const signInContext = await browser.newContext({ baseURL: baseUrl });
const signInPage = await signInContext.newPage();
await signInPage.goto("/login");
await signInPage.getByLabel(/email/i).fill(email);
await signInPage.getByLabel(/password/i).fill(password);
await signInPage.getByRole("button", { name: /sign in|log in/i }).click();
await signInPage.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
const storageState = await signInContext.storageState();
await signInContext.close();

const context = await browser.newContext({ baseURL: baseUrl, storageState });
if (policy !== null) {
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": policy },
    });
  });
}
await context.addInitScript(() => {
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__cspViolations.push({
      directive: event.effectiveDirective,
      blocked: event.blockedURI,
      source: event.sourceFile,
    });
  });
});

const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
const workerUrls = [];
const externalHosts = new Set();
const apiHost = new URL(apiOrigin).host;
const appHost = new URL(baseUrl).host;
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text());
  }
});
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("worker", (worker) => workerUrls.push(worker.url()));
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.protocol.startsWith("http") && url.host !== appHost && url.host !== apiHost) {
    externalHosts.add(url.host);
  }
});

const client = await context.newCDPSession(page);
await client.send("Network.enable");
const resources = new Map();
client.on("Network.responseReceived", (event) => {
  resources.set(event.requestId, {
    url: event.response.url,
    type: event.type,
    status: event.response.status,
    decoded: 0,
    encoded: 0,
  });
});
client.on("Network.dataReceived", (event) => {
  const resource = resources.get(event.requestId);
  if (resource) {
    resource.decoded += event.dataLength;
  }
});
client.on("Network.loadingFinished", (event) => {
  const resource = resources.get(event.requestId);
  if (resource) {
    resource.encoded = event.encodedDataLength;
  }
});

const result = { baseUrl, editorPath, cspMode, steps: { signedIn: true } };

let initialScriptPaths = new Set();

async function exerciseEditor() {
  const navigationStartedAt = Date.now();
  const documentResponse = await page.goto(editorPath);
  result.steps.documentStatus = documentResponse?.status();
  const documentHtml = await documentResponse?.text();
  initialScriptPaths = new Set(
    [...(documentHtml ?? "").matchAll(/\/_next\/static\/[^"'\\\s]+\.js/g)].map((match) => match[0]),
  );

  await page.getByTestId("code-editor").waitFor({ timeout: 60_000 });
  await page.locator(".monaco-editor").first().waitFor({ timeout: 60_000 });
  result.steps.editorVisibleMs = Date.now() - navigationStartedAt;

  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="schema-status"]')?.getAttribute("data-state") ===
      "ready",
    undefined,
    { timeout: 30_000 },
  );
  result.steps.schemaReady = true;

  result.steps.initialSampleMarkers = await waitForMarkerCount(
    page,
    (count) => count === 0,
    "no markers for the valid sample",
  );
  await page.waitForTimeout(1500);
  result.steps.initialSampleMarkersAfterSettle = Number(
    await page.getByTestId("marker-count").getAttribute("data-count"),
  );

  await page.getByRole("button", { name: "Load invalid sample" }).click();
  result.steps.invalidSampleMarkerCount = await waitForMarkerCount(
    page,
    (count) => count > 0,
    "markers for the invalid sample",
  );
  result.steps.invalidSampleMarkers = await readMarkers(page);

  await page.getByRole("button", { name: "Load valid sample" }).click();
  result.steps.validSampleMarkerCount = await waitForMarkerCount(
    page,
    (count) => count === 0,
    "markers cleared for the valid sample",
  );

  await replaceEditorText(page, SCHEMA_INVALID_FLOW_YAML, "insert");
  result.steps.typedSchemaInvalidMarkerCount = await waitForMarkerCount(
    page,
    (count) => count > 0,
    "markers for schema-invalid YAML",
  );
  result.steps.typedSchemaInvalidMarkers = await readMarkers(page);

  await replaceEditorText(page, VALID_FLOW_YAML, "insert");
  result.steps.typedValidMarkerCount = await waitForMarkerCount(
    page,
    (count) => count === 0,
    "markers cleared for valid YAML",
  );

  await replaceEditorText(page, SYNTAX_INVALID_YAML, "insert");
  result.steps.syntaxInvalidMarkerCount = await waitForMarkerCount(
    page,
    (count) => count > 0,
    "markers for syntax-invalid YAML",
  );
  result.steps.syntaxInvalidMarkers = await readMarkers(page);

  await replaceEditorText(page, VALID_FLOW_YAML, "insert");
  result.steps.validAgainMarkerCount = await waitForMarkerCount(
    page,
    (count) => count === 0,
    "markers cleared again",
  );

  await replaceEditorText(page, "app:", "type");
  await page.keyboard.type(" [broken", { delay: 20 });
  result.steps.keyboardTypedMarkerCount = await waitForMarkerCount(
    page,
    (count) => count > 0,
    "markers after real keyboard typing",
  );
}

try {
  await exerciseEditor();
} catch (error) {
  result.failure = error instanceof Error ? error.message.split("\n")[0] : String(error);
  result.screenshot = path.join(tmpdir(), "verify-editor-failure.png");
  await page.screenshot({ path: result.screenshot });
}

await page.waitForTimeout(500);
const scripts = [...resources.values()].filter(
  (resource) => /\/_next\/static\/.+\.js(\?|$)/.test(resource.url) || resource.type === "Script",
);
const classify = (resource) =>
  initialScriptPaths.has(new URL(resource.url).pathname) ? "initial" : "lazy";
const totals = { initial: [0, 0, 0], lazy: [0, 0, 0] };
for (const resource of scripts) {
  const bucket = totals[classify(resource)];
  bucket[0] += 1;
  bucket[1] += resource.decoded;
  bucket[2] += resource.encoded;
}
result.sizes = Object.fromEntries(
  Object.entries(totals).map(([name, [files, decoded, encoded]]) => [
    name,
    { files, decodedKb: bytesToKb(decoded), transferredKb: bytesToKb(encoded) },
  ]),
);

const workerChunkPaths = new Map();
for (const url of workerUrls) {
  const [entry, fragment] = url.split("#params=");
  const chunkLists = fragment ? JSON.parse(decodeURIComponent(fragment)) : [];
  const paths = [new URL(entry).pathname, ...(chunkLists[0] ?? [])];
  workerChunkPaths.set(url, paths);
}
const measuredWorkerChunks = new Map();
for (const paths of workerChunkPaths.values()) {
  for (const path of paths) {
    if (!measuredWorkerChunks.has(path)) {
      const response = await page.request.get(new URL(path, baseUrl).toString());
      const body = await response.body();
      measuredWorkerChunks.set(path, {
        decoded: body.length,
        gzip: gzipSync(body, { level: 6 }).length,
      });
    }
  }
}
result.workerSizes = {
  perWorker: [...workerChunkPaths.values()].map((paths) => {
    const measured = paths.map((path) => measuredWorkerChunks.get(path));
    return {
      files: paths.length,
      decodedKb: bytesToKb(measured.reduce((sum, item) => sum + item.decoded, 0)),
      gzipKb: bytesToKb(measured.reduce((sum, item) => sum + item.gzip, 0)),
    };
  }),
  uniqueFiles: measuredWorkerChunks.size,
  uniqueDecodedKb: bytesToKb(
    [...measuredWorkerChunks.values()].reduce((sum, item) => sum + item.decoded, 0),
  ),
  uniqueGzipKb: bytesToKb(
    [...measuredWorkerChunks.values()].reduce((sum, item) => sum + item.gzip, 0),
  ),
};
result.largestScripts = scripts
  .map((resource) => ({
    file: new URL(resource.url).pathname.split("/").pop(),
    kind: classify(resource),
    decodedKb: bytesToKb(resource.decoded),
    transferredKb: bytesToKb(resource.encoded),
  }))
  .sort((left, right) => right.decodedKb - left.decodedKb)
  .slice(0, 8);
result.workers = workerUrls.map((url) => ({
  scheme: url.split(":")[0],
  entry: url.split("#")[0].replace(baseUrl, ""),
}));
result.externalHosts = [...externalHosts];
result.cspViolations = await page.evaluate(() => window.__cspViolations);
result.consoleErrors = consoleErrors.slice(0, 10);
result.pageErrors = pageErrors.slice(0, 10);

await browser.close();
console.log(JSON.stringify(result, null, 2));
