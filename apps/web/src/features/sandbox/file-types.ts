/**
 * What a file's name says about it: the icon an editor shows beside it, and
 * the language its text is highlighted as. Pure, so both are decided from
 * the name alone, never from the content.
 */

/** Files known by their whole name, before their extension is looked at. */
const NAMED_FILES: ReadonlyMap<string, string> = new Map([
  ["package.json", "npm"],
  ["package-lock.json", "npm"],
  [".npmrc", "npm"],
  [".nvmrc", "node"],
  [".node-version", "node"],
  [".gitignore", "git"],
  [".gitattributes", "git"],
  [".gitkeep", "git"],
  [".editorconfig", "editorconfig"],
  ["dockerfile", "docker"],
  [".dockerignore", "docker"],
  ["makefile", "makefile"],
  ["license", "license"],
  ["license.md", "license"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
  ["cargo.toml", "cargo"],
  ["cargo.lock", "cargo"],
  ["go.mod", "go-package"],
  ["go.sum", "go-package"],
  ["requirements.txt", "pip"],
]);

/** Names known by how they start: `tsconfig.build.json`, `vite.config.ts`. */
const PREFIXED_FILES: readonly (readonly [RegExp, string])[] = [
  [/^tsconfig(\..+)?\.json$/, "tsconfig"],
  [/^vite\.config\./, "vite"],
  [/^vitest\.config\./, "vitest"],
  [/^jest\.config\./, "jest"],
  [/^(\.eslintrc|eslint\.config\.)/, "eslint"],
  [/^\.prettierrc/, "prettier"],
  [/^\.env(\..+)?$/, "dotenv"],
  [/\.(test|spec)\.(ts|tsx|mts|cts)$/, "testts"],
  [/\.(test|spec)\.(js|jsx|mjs|cjs)$/, "testjs"],
];

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["tsx", "reactts"],
  ["js", "js"],
  ["mjs", "js"],
  ["cjs", "js"],
  ["jsx", "reactjs"],
  ["json", "json"],
  ["jsonc", "json"],
  ["md", "markdown"],
  ["mdx", "markdown"],
  ["yml", "yaml"],
  ["yaml", "yaml"],
  ["toml", "toml"],
  ["ini", "ini"],
  ["env", "dotenv"],
  ["css", "css"],
  ["scss", "scss"],
  ["html", "html"],
  ["xml", "xml"],
  ["svg", "svg"],
  ["py", "python"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["rb", "ruby"],
  ["php", "php"],
  ["cs", "csharp"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["hpp", "cpp"],
  ["swift", "swift"],
  ["dart", "dartlang"],
  ["scala", "scala"],
  ["ex", "elixir"],
  ["exs", "elixir"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["sql", "sql"],
  ["mmd", "mermaid"],
  ["mermaid", "mermaid"],
  ["dot", "graphviz"],
  ["gv", "graphviz"],
  ["feature", "cucumber"],
  ["txt", "text"],
  ["log", "log"],
  ["pdf", "pdf"],
  ["zip", "zip"],
  ["png", "image"],
  ["jpg", "image"],
  ["jpeg", "image"],
  ["gif", "image"],
  ["webp", "image"],
  ["ico", "image"],
]);

/** Folders with an icon of their own, by the names they usually go by. */
const FOLDERS: ReadonlyMap<string, string> = new Map([
  ["src", "src"],
  ["source", "src"],
  ["test", "test"],
  ["tests", "test"],
  ["__tests__", "test"],
  ["spec", "test"],
  ["private", "private"],
  ["public", "public"],
  ["dist", "dist"],
  ["build", "dist"],
  ["out", "dist"],
  ["config", "config"],
  ["scripts", "script"],
  ["docs", "docs"],
  ["lib", "library"],
  [".github", "github"],
  ["node_modules", "node"],
  ["docker", "docker"],
]);

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? undefined : name.slice(dot + 1).toLowerCase();
}

/** The vscode-icons name of a file's icon: `file-type-typescript`. */
export function fileIconName(name: string): string {
  const lower = name.toLowerCase();
  const type =
    NAMED_FILES.get(lower) ??
    PREFIXED_FILES.find(([pattern]) => pattern.test(lower))?.[1] ??
    EXTENSIONS.get(extensionOf(lower) ?? "");
  return type === undefined ? "default-file" : `file-type-${type}`;
}

/** The vscode-icons name of a folder's icon, open or closed. */
export function folderIconName(name: string, open: boolean): string {
  const type = FOLDERS.get(name.toLowerCase());
  const base = type === undefined ? "default-folder" : `folder-type-${type}`;
  return open ? `${base}-opened` : base;
}

/** A language as a highlighter knows it, and as a person reads its name. */
export interface Language {
  id: string;
  label: string;
}

const PLAIN_TEXT: Language = { id: "text", label: "Plain Text" };
const DOTENV: Language = { id: "dotenv", label: "Environment Variables" };

const LANGUAGE_BY_NAME: ReadonlyMap<string, Language> = new Map([
  ["dockerfile", { id: "docker", label: "Dockerfile" }],
  ["makefile", { id: "make", label: "Makefile" }],
  [".npmrc", { id: "ini", label: "Properties" }],
  [".editorconfig", { id: "ini", label: "Properties" }],
]);

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, Language> = new Map(
  (
    [
      [["ts", "mts", "cts"], "typescript", "TypeScript"],
      [["tsx"], "tsx", "TypeScript JSX"],
      [["js", "mjs", "cjs"], "javascript", "JavaScript"],
      [["jsx"], "jsx", "JavaScript JSX"],
      [["json"], "json", "JSON"],
      [["jsonc"], "jsonc", "JSON with Comments"],
      [["md"], "markdown", "Markdown"],
      [["mdx"], "mdx", "MDX"],
      [["yml", "yaml"], "yaml", "YAML"],
      [["toml"], "toml", "TOML"],
      [["ini"], "ini", "Properties"],
      [["css"], "css", "CSS"],
      [["scss"], "scss", "SCSS"],
      [["html"], "html", "HTML"],
      [["xml", "svg"], "xml", "XML"],
      [["py"], "python", "Python"],
      [["go"], "go", "Go"],
      [["rs"], "rust", "Rust"],
      [["java"], "java", "Java"],
      [["kt", "kts"], "kotlin", "Kotlin"],
      [["rb"], "ruby", "Ruby"],
      [["php"], "php", "PHP"],
      [["cs"], "csharp", "C#"],
      [["c", "h"], "c", "C"],
      [["cpp", "cc", "hpp"], "cpp", "C++"],
      [["swift"], "swift", "Swift"],
      [["dart"], "dart", "Dart"],
      [["scala"], "scala", "Scala"],
      [["ex", "exs"], "elixir", "Elixir"],
      [["sh", "bash", "zsh"], "shellscript", "Shell Script"],
      [["sql"], "sql", "SQL"],
      [["feature"], "gherkin", "Gherkin"],
      [["mmd", "mermaid"], "mermaid", "Mermaid"],
    ] as const
  ).flatMap(([extensions, id, label]) =>
    extensions.map((extension) => [extension, { id, label }] as const),
  ),
);

/** The language a file's text is highlighted as; plain text when unknown. */
export function languageOf(path: string): Language {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (/^\.env(\..+)?$/.test(name) || name.endsWith(".env")) return DOTENV;
  return (
    LANGUAGE_BY_NAME.get(name) ??
    LANGUAGE_BY_EXTENSION.get(extensionOf(name) ?? "") ??
    PLAIN_TEXT
  );
}
