import type { CodeEditorProps } from "@/components/editor/code-editor";

export function CodeEditor({
  value,
  path,
  ariaLabel,
  language = "yaml",
  readOnly = false,
  onChange,
}: CodeEditorProps) {
  return (
    <textarea
      data-testid="code-editor-mock"
      data-language={language}
      data-path={path}
      aria-label={ariaLabel}
      readOnly={readOnly}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}
