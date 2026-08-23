import { describe, expect, it } from "vitest";
import { buildValidationError } from "@/mocks/factories/bundles";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import { describeLocation, groupProblemsByFile, ValidationErrors } from "./validation-errors";

const MANIFEST_ERROR = buildValidationError({
  code: "enum_mismatch",
  message: "'kind' must be one of read, write",
  pointer: "/features/3/kind",
  line: 71,
  column: 11,
});
const SECOND_MANIFEST_ERROR = buildValidationError({
  code: "required_property_missing",
  message: "'seeds' is a required property",
  pointer: "/seeds",
  line: 212,
  column: 1,
});
const TEMPLATE_ERROR = buildValidationError({
  code: "placeholder_not_in_env_template",
  message: "Placeholder is not declared",
  file: "env.template",
  line: 3,
});
const WARNING_ON_MANIFEST = buildValidationError({
  code: "oracle_missing",
  message: "names oracle 'user_by_token' but oracle/ has no such file",
  severity: "warning",
  pointer: "/features/8/examples/0/oracle",
  line: 188,
  column: 15,
});
const WARNING_ON_SEED = buildValidationError({
  code: "file_ignored",
  message: "Non-text entry ignored",
  severity: "warning",
  file: "seeds/dump.bin",
});

describe("groupProblemsByFile", () => {
  it("groups by file and puts files with errors first", () => {
    const groups = groupProblemsByFile(
      [MANIFEST_ERROR, TEMPLATE_ERROR, SECOND_MANIFEST_ERROR],
      [WARNING_ON_SEED, WARNING_ON_MANIFEST],
    );

    expect(groups.map((group) => group.file)).toEqual([
      "manifest.yaml",
      "env.template",
      "seeds/dump.bin",
    ]);
    expect(groups[0]?.errors).toHaveLength(2);
    expect(groups[0]?.warnings).toHaveLength(1);
  });
});

describe("describeLocation", () => {
  it("combines line and column and drops what is missing", () => {
    expect(describeLocation(MANIFEST_ERROR)).toBe("line 71, column 11");
    expect(describeLocation(TEMPLATE_ERROR)).toBe("line 3");
    expect(describeLocation(WARNING_ON_SEED)).toBeNull();
  });
});

describe("ValidationErrors", () => {
  it("groups the problems by file with severity, pointer, line and column", () => {
    renderWithProviders(
      <ValidationErrors
        errors={[MANIFEST_ERROR, TEMPLATE_ERROR, SECOND_MANIFEST_ERROR]}
        warnings={[WARNING_ON_MANIFEST, WARNING_ON_SEED]}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Validation errors" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 errors and 2 warnings in 3 files.")).toBeInTheDocument();
    const manifest = within(screen.getByRole("region", { name: "Problems in manifest.yaml" }));
    expect(manifest.getByRole("heading", { level: 3 })).toHaveTextContent(
      "manifest.yaml2 errors, 1 warning",
    );
    const items = manifest.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.getAttribute("data-severity"))).toEqual([
      "error",
      "error",
      "warning",
    ]);
    const first = within(items[0] as HTMLElement);
    expect(first.getByText("Error")).toBeInTheDocument();
    expect(first.getByText("enum_mismatch")).toBeInTheDocument();
    expect(first.getByText("'kind' must be one of read, write")).toBeInTheDocument();
    expect(first.getByText("/features/3/kind")).toBeInTheDocument();
    expect(first.getByText("line 71, column 11")).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getByText("Warning")).toBeInTheDocument();
    const template = within(screen.getByRole("region", { name: "Problems in env.template" }));
    expect(template.getByText("line 3")).toBeInTheDocument();
    expect(template.queryByText(/Pointer/)).not.toBeInTheDocument();
  });

  it("lists warnings alone under a neutral heading", () => {
    renderWithProviders(<ValidationErrors errors={[]} warnings={[WARNING_ON_SEED]} />);

    expect(screen.getByRole("heading", { level: 2, name: "Validation" })).toBeInTheDocument();
    expect(screen.getByText("0 errors and 1 warning in 1 file.")).toBeInTheDocument();
    expect(screen.getByText("Non-text entry ignored")).toBeInTheDocument();
  });

  it("says so when there is nothing to report", () => {
    renderWithProviders(<ValidationErrors errors={[]} warnings={[]} />);

    expect(screen.getByText("No errors or warnings.")).toBeInTheDocument();
    expect(screen.getByText("The bundle passed every validation rule.")).toBeInTheDocument();
  });
});
