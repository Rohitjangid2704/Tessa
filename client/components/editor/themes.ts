import type * as Monaco from "monaco-editor";

export const LIGHT_EDITOR_THEME = "tessa-light";
export const DARK_EDITOR_THEME = "tessa-dark";

export const LIGHT_EDITOR_BACKGROUND = "ffffff";
export const DARK_EDITOR_BACKGROUND = "1e1e1e";

export const LIGHT_TOKEN_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: "annotation", foreground: "595959" },
  { token: "string.sql", foreground: "C00000" },
  { token: "operator.sql", foreground: "4B5563" },
  { token: "attribute.name", foreground: "C00000" },
  { token: "metatag.content.html", foreground: "C00000" },
  { token: "metatag.html", foreground: "595959" },
  { token: "metatag.xml", foreground: "595959" },
];

export const DARK_TOKEN_RULES: Monaco.editor.ITokenThemeRule[] = [
  { token: "variable.predefined", foreground: "7C9BE0" },
  { token: "comment", foreground: "7FA66A" },
  { token: "regexp", foreground: "D18CB8" },
  { token: "annotation", foreground: "E07F7F" },
  { token: "delimiter.html", foreground: "A0A0A0" },
  { token: "delimiter.xml", foreground: "A0A0A0" },
  { token: "tag.id.pug", foreground: "7FA3D6" },
  { token: "tag.class.pug", foreground: "7FA3D6" },
  { token: "string.sql", foreground: "FF7B7B" },
];

export function defineEditorThemes(monaco: typeof Monaco): void {
  monaco.editor.defineTheme(LIGHT_EDITOR_THEME, {
    base: "vs",
    inherit: true,
    rules: LIGHT_TOKEN_RULES,
    colors: {},
  });
  monaco.editor.defineTheme(DARK_EDITOR_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: DARK_TOKEN_RULES,
    colors: {},
  });
}

export function editorThemeName(resolvedTheme: string | undefined): string {
  return resolvedTheme === "dark" ? DARK_EDITOR_THEME : LIGHT_EDITOR_THEME;
}
