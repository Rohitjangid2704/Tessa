import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  buildBundle,
  buildBundleUploadResult,
  buildCompleteness,
  buildValidationError,
  type BundleUploadResult,
} from "@/mocks/factories/bundles";
import { MEMBER_USER, VIEWER_USER } from "@/mocks/factories/users";
import { mockState } from "@/mocks/handlers";
import { signInAs } from "@/tests/utils/api-session";
import { STAGE_ONE_IDS } from "@/tests/utils/stage1";
import {
  fireEvent,
  renderWithProviders,
  screen,
  userEvent,
  waitFor,
  within,
} from "@/tests/utils/render";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

const requests = vi.hoisted(() => ({
  upload: vi.fn(),
  paste: vi.fn(),
}));

vi.mock("../bundle-requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bundle-requests")>()),
  uploadBundleRequest: requests.upload,
  pasteManifestRequest: requests.paste,
}));

const { BundleIntake } = await import("./bundle-intake");

const GRACIE = STAGE_ONE_IDS.gracie;
const BILLING = STAGE_ONE_IDS.billing;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
  reject: (reason: unknown) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function zipFile(name = "tessa.zip", bytes = 2048): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/zip" });
}

function createdResult(
  overrides: Partial<ReturnType<typeof buildBundle>> = {},
): BundleUploadResult {
  return buildBundleUploadResult(
    buildBundle({
      id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a03",
      target_id: GRACIE,
      version: 3,
      feature_count: 15,
      file_count: 9,
      size_bytes: 20_480,
      diff_summary: {
        against_bundle_id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a02",
        against_version: 2,
        features_added: 1,
        features_removed: 0,
        features_changed: 2,
      },
      ...overrides,
    }),
  );
}

function fileInput(): HTMLInputElement {
  const input = screen.getByLabelText("Bundle zip");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the file input is missing");
  }
  return input;
}

async function chooseFile(file: File) {
  const user = userEvent.setup();
  await user.upload(fileInput(), file);
  return user;
}

async function renderIntake(targetId: string = GRACIE) {
  const view = renderWithProviders(<BundleIntake targetId={targetId} />);
  await screen.findByText(/at most [\d.]+ (B|KiB|MiB)/);
  await waitFor(() => expect(fileInput()).toBeEnabled());
  return view;
}

beforeEach(async () => {
  requests.upload.mockReset();
  requests.paste.mockReset();
  await signInAs(MEMBER_USER);
});

describe("BundleIntake idle", () => {
  it("shows the drop zone, the paste button and the versions of the target newest first", async () => {
    await renderIntake();

    expect(screen.getByLabelText("Bundle zip")).toBeEnabled();
    expect(screen.getByText("A .zip of the tessa folder, at most 25 MiB.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste manifest instead" })).toBeEnabled();
    const table = await screen.findByRole("table", { name: "Bundle versions" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "Version 2" })).toHaveAttribute(
      "href",
      expect.stringMatching(new RegExp(`^/targets/${GRACIE}/bundles/[0-9a-f-]+$`)),
    );
    expect(within(rows[0]!).getByText("92 of 100")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("55 of 100")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Below bar")).toBeInTheDocument();
  });

  it("guides the first upload of a target without versions", async () => {
    await renderIntake(BILLING);

    expect(await screen.findByRole("heading", { name: "No versions yet" })).toBeInTheDocument();
    expect(
      screen.getByText("Compress-Archive -Path tessa -DestinationPath tessa.zip"),
    ).toBeInTheDocument();
  });

  it("shows the server limit read from GET /limits and no other", async () => {
    mockState.stageOne.configureLimits({ bundle_max_zip_bytes: 3 * 1024 * 1024 });

    await renderIntake();

    expect(screen.getByText("A .zip of the tessa folder, at most 3 MiB.")).toBeInTheDocument();
  });

  it("is read-only for a viewer but still lists the versions", async () => {
    await signInAs(VIEWER_USER);
    renderWithProviders(<BundleIntake targetId={GRACIE} />);

    expect(await screen.findByText(/You have read-only access/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Bundle zip")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Paste manifest instead" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "Bundle versions" })).toBeInTheDocument();
  });
});

describe("BundleIntake pre-checks", () => {
  it("rejects a file over the size from GET /limits before any request", async () => {
    mockState.stageOne.configureLimits({ bundle_max_zip_bytes: 1024 });
    await renderIntake();

    await chooseFile(zipFile("big.zip", 4096));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "big.zip is 4 KiB; the server accepts at most 1 KiB.",
    );
    expect(screen.queryByRole("group", { name: "File ready to upload" })).not.toBeInTheDocument();
    expect(requests.upload).not.toHaveBeenCalled();
  });

  it("rejects a file that is not a zip", async () => {
    await renderIntake();

    fireEvent.change(fileInput(), {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("notes.txt is not a .zip file");
    expect(requests.upload).not.toHaveBeenCalled();
  });

  it("stages a chosen zip with its name and size and waits for the button", async () => {
    await renderIntake();

    await chooseFile(zipFile("tessa.zip", 3000));

    const staged = screen.getByRole("group", { name: "File ready to upload" });
    expect(within(staged).getByText("tessa.zip")).toBeInTheDocument();
    expect(within(staged).getByText("2.9 KiB")).toBeInTheDocument();
    expect(requests.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Upload and validate" })).toBeEnabled();
  });

  it("removes a staged file again", async () => {
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Remove tessa.zip" }));

    expect(screen.queryByRole("group", { name: "File ready to upload" })).not.toBeInTheDocument();
  });
});

describe("BundleIntake upload", () => {
  it("sends the file, target, note and an idempotency key and shows the new version", async () => {
    requests.upload.mockResolvedValue(createdResult());
    await renderIntake();
    const file = zipFile("tessa.zip");
    const user = await chooseFile(file);
    await user.type(screen.getByLabelText("Note (optional)"), "after the fix-up");

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const result = await screen.findByRole("region", { name: "Upload result" });
    expect(requests.upload).toHaveBeenCalledTimes(1);
    const [, input] = requests.upload.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({ file, targetId: GRACIE, note: "after the fix-up" });
    expect(typeof input.idempotencyKey).toBe("string");
    expect(within(result).getByRole("heading", { name: "Version 3 created" })).toBeInTheDocument();
    expect(within(result).getByText("Valid")).toBeInTheDocument();
    expect(within(result).getByText("Meets bar")).toBeInTheDocument();
    expect(within(result).getByText("Score 100 of 100, bar 80")).toBeInTheDocument();
    expect(
      within(result).getByText("Compared with version 2: 1 added, 0 removed, 2 changed."),
    ).toBeInTheDocument();
    expect(within(result).getByRole("link", { name: "Open version 3" })).toHaveAttribute(
      "href",
      `/targets/${GRACIE}/bundles/0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a03`,
    );
    expect(within(result).getByRole("link", { name: "View the catalog" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "File ready to upload" })).not.toBeInTheDocument();
  });

  it("says the first version has nothing to compare with", async () => {
    requests.upload.mockResolvedValue(createdResult({ version: 1, diff_summary: null }));
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    expect(
      await screen.findByText("First version, so there is nothing to compare with."),
    ).toBeInTheDocument();
  });

  it("explains a below-bar version without a success tone only", async () => {
    requests.upload.mockResolvedValue(
      createdResult({
        completeness: buildCompleteness({
          required_sections: { earned: 20 },
          feature_interface_roles: { earned: 12 },
          feature_examples: { earned: 8 },
          oracle_read_only: { earned: 5 },
          env_template_coverage: { earned: 10 },
          seeds_reset_and_hash: { earned: 0 },
        }),
      }),
    );
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const result = await screen.findByRole("region", { name: "Upload result" });
    expect(within(result).getByText("Below bar")).toBeInTheDocument();
    expect(within(result).getByText("Score 55 of 100, bar 80")).toBeInTheDocument();
    expect(within(result).getByText(/below the completeness bar/)).toBeInTheDocument();
  });

  it("stores an invalid version with its errors and offers no catalog link", async () => {
    requests.upload.mockResolvedValue(
      createdResult({
        validation_status: "invalid",
        errors: [buildValidationError(), buildValidationError({ code: "enum_mismatch" })],
        warnings: [buildValidationError({ severity: "warning", code: "file_ignored" })],
      }),
    );
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const result = await screen.findByRole("region", { name: "Upload result" });
    expect(
      within(result).getByRole("heading", { name: "Version 3 stored with errors" }),
    ).toBeInTheDocument();
    expect(within(result).getByText("Invalid")).toBeInTheDocument();
    expect(within(result).getByText("2 errors, 1 warning")).toBeInTheDocument();
    expect(
      within(result).queryByRole("link", { name: "View the catalog" }),
    ).not.toBeInTheDocument();
  });

  it("reports identical content as the existing version", async () => {
    requests.upload.mockResolvedValue({ ...createdResult({ version: 2 }), created: false });
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const result = await screen.findByRole("region", { name: "Upload result" });
    expect(
      within(result).getByRole("heading", { name: "Identical to version 2" }),
    ).toBeInTheDocument();
    expect(within(result).getByText(/nothing new was created/)).toBeInTheDocument();
  });

  it("blocks the whole intake while validating and ignores a second submit", async () => {
    const pending = deferred<BundleUploadResult>();
    requests.upload.mockReturnValue(pending.promise);
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const progress = await screen.findByText(/Validating the zip/);
    expect(progress).toBeInTheDocument();
    const busyButton = screen.getByRole("button", { name: "Validating" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(fileInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Paste manifest instead" })).toBeDisabled();
    await user.click(busyButton);
    expect(requests.upload).toHaveBeenCalledTimes(1);

    pending.resolve(createdResult());

    await screen.findByRole("region", { name: "Upload result" });
    expect(screen.queryByText(/Validating the zip/)).not.toBeInTheDocument();
    expect(fileInput()).toBeEnabled();
  });
});

describe("BundleIntake failures", () => {
  it("lists every secret finding, says nothing was stored and keeps the file for a retry", async () => {
    requests.upload.mockRejectedValue(
      new ApiError({
        status: 422,
        code: "bundle_contains_secret",
        message: "The bundle contains 2 apparent secret(s) in 2 file(s); nothing was stored.",
        requestId: "req-secret",
        details: [
          { loc: ["file", "env.template", 7], code: "aws_access_key", message: "KEY=[REDACTED]" },
          {
            loc: ["file", "seeds/reset.sql", 12],
            code: "dsn_password",
            message: "psql postgresql://u:[REDACTED]@db/x",
          },
        ],
      }),
    );
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const alert = await screen.findByRole("alert", { name: "Upload failed" });
    expect(
      within(alert).getByRole("heading", { name: "The bundle contains what look like secrets" }),
    ).toBeInTheDocument();
    expect(within(alert).getByText(/Nothing was stored/)).toBeInTheDocument();
    const table = within(alert).getByRole("table", { name: "Secrets found" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      within(rows[0]!)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["env.template", "7", "aws_access_key", "KEY=[REDACTED]"]);
    expect(within(rows[1]!).getByText("seeds/reset.sql")).toBeInTheDocument();
    expect(within(alert).getByText("Request ID: req-secret")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "File ready to upload" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload and validate" })).toBeEnabled();
  });

  it("keeps the idempotency key for a retry of the same file and rotates it for another file", async () => {
    requests.upload
      .mockRejectedValueOnce(ApiError.network(new TypeError("fetch failed")))
      .mockRejectedValueOnce(ApiError.network(new TypeError("fetch failed")))
      .mockResolvedValue(createdResult());
    await renderIntake();
    const first = zipFile("first.zip");
    const user = await chooseFile(first);

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    await screen.findByRole("alert", { name: "Upload failed" });
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(requests.upload).toHaveBeenCalledTimes(2));
    await screen.findByRole("alert", { name: "Upload failed" });

    await user.upload(fileInput(), zipFile("second.zip"));
    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    await screen.findByRole("region", { name: "Upload result" });

    const keys = requests.upload.mock.calls.map(
      ([, input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("uses a new key when the note changes between attempts", async () => {
    requests.upload
      .mockRejectedValueOnce(ApiError.network(new TypeError("fetch failed")))
      .mockResolvedValue(createdResult());
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    await screen.findByRole("alert", { name: "Upload failed" });
    await user.type(screen.getByLabelText("Note (optional)"), "retry with a note");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Upload result" });

    const keys = requests.upload.mock.calls.map(
      ([, input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("starts the next upload of the same file with a new key after a success", async () => {
    requests.upload.mockResolvedValue(createdResult());
    await renderIntake();
    const file = zipFile();
    const user = await chooseFile(file);
    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    await screen.findByRole("region", { name: "Upload result" });

    await user.upload(fileInput(), file);
    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    await waitFor(() => expect(requests.upload).toHaveBeenCalledTimes(2));

    const keys = requests.upload.mock.calls.map(
      ([, input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("maps a server size limit the client did not know about", async () => {
    requests.upload.mockRejectedValue(
      new ApiError({
        status: 413,
        code: "payload_too_large",
        message: "The zip is larger than 26214400 bytes",
        details: [
          {
            loc: ["file"],
            code: "archive_too_large",
            message: "The zip is larger than 26214400 bytes",
          },
        ],
      }),
    );
    await renderIntake();
    const user = await chooseFile(zipFile());

    await user.click(screen.getByRole("button", { name: "Upload and validate" }));

    const alert = await screen.findByRole("alert", { name: "Upload failed" });
    expect(
      within(alert).getByText("The zip is larger than the server accepts"),
    ).toBeInTheDocument();
    expect(within(alert).getByText("The zip is larger than 26214400 bytes")).toBeInTheDocument();
  });

  it("dismisses a failure", async () => {
    requests.upload.mockRejectedValue(
      new ApiError({ status: 403, code: "role_required", message: "no" }),
    );
    await renderIntake();
    const user = await chooseFile(zipFile());
    await user.click(screen.getByRole("button", { name: "Upload and validate" }));
    const alert = await screen.findByRole("alert", { name: "Upload failed" });

    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert", { name: "Upload failed" })).not.toBeInTheDocument();
  });
});

describe("BundleIntake paste", () => {
  async function openDialog() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Paste manifest instead" }));
    const dialog = await screen.findByRole("dialog", { name: "Paste manifest.yaml" });
    return { user, dialog };
  }

  it("posts the manifest with a note and shows the result on the page", async () => {
    requests.paste.mockResolvedValue(
      createdResult({
        source: "manifest_paste",
        version: 4,
        id: "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a04",
      }),
    );
    await renderIntake();
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByLabelText("manifest.yaml"));
    await user.paste("schema: x\ntarget_token: y\n");
    await user.type(within(dialog).getByLabelText("Note (optional)"), "pasted");
    await user.click(within(dialog).getByRole("button", { name: "Add version" }));

    const result = await screen.findByRole("region", { name: "Upload result" });
    expect(within(result).getByRole("heading", { name: "Version 4 created" })).toBeInTheDocument();
    expect(requests.paste).toHaveBeenCalledTimes(1);
    const [, input] = requests.paste.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input).toMatchObject({
      manifestYaml: "schema: x\ntarget_token: y\n",
      targetId: GRACIE,
      note: "pasted",
    });
    expect(typeof input.idempotencyKey).toBe("string");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the dialog and the text on a failure and retries with the same key", async () => {
    requests.paste
      .mockRejectedValueOnce(ApiError.network(new TypeError("fetch failed")))
      .mockResolvedValue(createdResult());
    await renderIntake();
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByLabelText("manifest.yaml"));
    await user.paste("schema: x\n");

    await user.click(within(dialog).getByRole("button", { name: "Add version" }));

    const alert = await within(dialog).findByRole("alert", { name: "Upload failed" });
    expect(
      within(alert).getByRole("heading", { name: "Cannot reach the Tessa API" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText("manifest.yaml")).toHaveValue("schema: x\n");

    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Upload result" });
    const keys = requests.paste.mock.calls.map(
      ([, input]) => (input as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("offers Add version again after a failure that a retry cannot fix", async () => {
    requests.paste.mockRejectedValue(
      new ApiError({
        status: 422,
        code: "target_token_unknown",
        message: "unknown",
        details: [
          { loc: ["manifest", "target_token"], code: "target_token_unknown", message: "unknown" },
        ],
      }),
    );
    await renderIntake();
    const { user, dialog } = await openDialog();
    await user.click(within(dialog).getByLabelText("manifest.yaml"));
    await user.paste("schema: x\n");

    await user.click(within(dialog).getByRole("button", { name: "Add version" }));

    await within(dialog).findByRole("heading", {
      name: "The target token in manifest.yaml is not known",
    });
    expect(within(dialog).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add version" })).toBeEnabled();
  });

  it("blocks a manifest over the limit from GET /limits and counts bytes", async () => {
    mockState.stageOne.configureLimits({ bundle_max_manifest_bytes: 10 });
    await renderIntake();
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByLabelText("manifest.yaml"));
    await user.paste("schema: a very long manifest line");

    expect(
      await within(dialog).findByText(/is over the limit of 10 B\. Shorten the manifest\./),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add version" })).toBeDisabled();
  });

  it("does not submit an empty manifest", async () => {
    await renderIntake();
    const { dialog } = await openDialog();

    expect(within(dialog).getByRole("button", { name: "Add version" })).toBeDisabled();
    expect(requests.paste).not.toHaveBeenCalled();
  });
});
