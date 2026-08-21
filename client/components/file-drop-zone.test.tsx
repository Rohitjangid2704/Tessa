import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, userEvent } from "@/tests/utils/render";
import { FileDropZone } from "./file-drop-zone";

const ONE_MEBIBYTE = 1024 * 1024;

function zipFile(name = "tessa.zip", bytes = 128): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/zip" });
}

function setup(props: Partial<Parameters<typeof FileDropZone>[0]> = {}) {
  const onFile = vi.fn();
  const onReject = vi.fn();
  renderWithProviders(
    <FileDropZone
      title="Bundle zip"
      description="A .zip of the tessa folder."
      extensions={[".zip"]}
      acceptMediaTypes={["application/zip"]}
      maxBytes={ONE_MEBIBYTE}
      onFile={onFile}
      onReject={onReject}
      {...props}
    />,
  );
  const input = screen.getByLabelText("Bundle zip");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("the drop zone has no file input");
  }
  return { input, onFile, onReject, zone: input.closest("[data-slot='file-drop-zone']") };
}

function dropEventInit(files: File[], kinds: string[] = ["Files"]) {
  return {
    dataTransfer: {
      files,
      types: kinds,
      items: files.map(() => ({ kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }) })),
    },
  };
}

describe("FileDropZone as a labelled file input", () => {
  it("exposes one input named by the title, described by the hint, limited to the zip type", () => {
    const { input } = setup();

    expect(input).toHaveAttribute("type", "file");
    expect(input).toHaveAccessibleName("Bundle zip");
    expect(input).toHaveAccessibleDescription("A .zip of the tessa folder.");
    expect(input).toHaveAttribute("accept", ".zip,application/zip");
    expect(input).not.toHaveAttribute("multiple");
  });

  it("is reached with Tab and activated with Enter and Space", async () => {
    const user = userEvent.setup();
    const { input } = setup();
    const clicks = vi.fn();
    input.addEventListener("click", clicks);

    await user.tab();
    expect(input).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(clicks).toHaveBeenCalledTimes(1);

    await user.keyboard(" ");
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it("hands an accepted zip to the caller and clears the input for the next choice", async () => {
    const user = userEvent.setup();
    const { input, onFile, onReject } = setup();
    const file = zipFile();

    await user.upload(input, file);

    expect(onFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(onReject).not.toHaveBeenCalled();
    expect(input.files).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects a file of the wrong type with a message tied to the input", () => {
    const { input, onFile, onReject } = setup();
    const notes = new File(["hello"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [notes] } });

    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith({ reason: "wrong_type", fileName: "notes.txt" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "notes.txt is not a .zip file. Only .zip files are accepted.",
    );
    expect(input).toHaveAccessibleDescription(/not a \.zip file/);
    expect(input).toBeInvalid();
  });

  it("accepts the extension in any letter case", () => {
    const { input, onFile } = setup();
    const upper = new File([new Uint8Array(4)], "BUNDLE.ZIP", { type: "" });

    fireEvent.change(input, { target: { files: [upper] } });

    expect(onFile).toHaveBeenCalledWith(upper);
  });

  it("rejects an empty file", () => {
    const { input, onFile } = setup();

    fireEvent.change(input, { target: { files: [zipFile("empty.zip", 0)] } });

    expect(onFile).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("empty.zip is empty (0 bytes).");
  });

  it("rejects a file over the size the server reports and names both sizes", () => {
    const { input, onFile, onReject } = setup({ maxBytes: 1024 });

    fireEvent.change(input, { target: { files: [zipFile("big.zip", 2048)] } });

    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith({
      reason: "too_large",
      fileName: "big.zip",
      sizeBytes: 2048,
      maxBytes: 1024,
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "big.zip is 2 KiB; the server accepts at most 1 KiB.",
    );
  });

  it("skips the size check while the limit is unknown and leaves it to the server", () => {
    const { input, onFile } = setup({ maxBytes: null });

    fireEvent.change(input, { target: { files: [zipFile("big.zip", 4 * ONE_MEBIBYTE)] } });

    expect(onFile).toHaveBeenCalledTimes(1);
  });

  it("clears an earlier rejection once a valid file is chosen", () => {
    const { input } = setup();

    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [zipFile()] } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("is disabled as a whole while an upload runs", () => {
    const { input, zone } = setup({ disabled: true });

    expect(input).toBeDisabled();
    expect(zone).toHaveAttribute("data-disabled", "true");
  });
});

describe("FileDropZone drag and drop", () => {
  it("shows the drag state while files are over the zone and leaves it again", () => {
    const { zone } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }
    expect(zone).toHaveAttribute("data-dragging", "false");

    fireEvent.dragEnter(zone, dropEventInit([zipFile()]));
    expect(zone).toHaveAttribute("data-dragging", "true");
    expect(screen.getByText("Release to choose this file")).toBeInTheDocument();

    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute("data-dragging", "false");
  });

  it("stays in the drag state while the pointer crosses child elements", () => {
    const { zone } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }
    const child = screen.getByText("Bundle zip");

    fireEvent.dragEnter(zone, dropEventInit([zipFile()]));
    fireEvent.dragEnter(child, dropEventInit([zipFile()]));
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute("data-dragging", "true");

    fireEvent.dragLeave(child);
    expect(zone).toHaveAttribute("data-dragging", "false");
  });

  it("ignores drags that carry no files such as selected text", () => {
    const { zone } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }

    fireEvent.dragEnter(zone, dropEventInit([], ["text/plain"]));

    expect(zone).toHaveAttribute("data-dragging", "false");
  });

  it("accepts a dropped zip and resets the drag state", () => {
    const { zone, onFile } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }
    const file = zipFile();

    fireEvent.dragEnter(zone, dropEventInit([file]));
    fireEvent.drop(zone, dropEventInit([file]));

    expect(onFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(zone).toHaveAttribute("data-dragging", "false");
  });

  it("rejects more than one dropped file", () => {
    const { zone, onFile, onReject } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }

    fireEvent.drop(zone, dropEventInit([zipFile("a.zip"), zipFile("b.zip")]));

    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith({ reason: "multiple", count: 2 });
    expect(screen.getByRole("alert")).toHaveTextContent("Drop one file at a time (2 were given).");
  });

  it("rejects a dropped folder and says to zip it first", () => {
    const { zone, onFile, onReject } = setup();
    if (zone === null) {
      throw new Error("zone missing");
    }
    const folder = new File([], "tessa", { type: "" });

    fireEvent.drop(zone, {
      dataTransfer: {
        files: [folder],
        types: ["Files"],
        items: [{ kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }) }],
      },
    });

    expect(onFile).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith({ reason: "directory" });
    expect(screen.getByRole("alert")).toHaveTextContent("Zip the folder first");
  });

  it("does nothing on drop while disabled", () => {
    const { zone, onFile } = setup({ disabled: true });
    if (zone === null) {
      throw new Error("zone missing");
    }

    fireEvent.dragEnter(zone, dropEventInit([zipFile()]));
    expect(zone).toHaveAttribute("data-dragging", "false");
    fireEvent.drop(zone, dropEventInit([zipFile()]));

    expect(onFile).not.toHaveBeenCalled();
  });
});
