/**
 * Source text coloured as Visual Studio Code colours it: its TextMate
 * grammars and its default dark theme, through Shiki.
 *
 * Loaded on demand, a language at a time, so the page pays for the grammars
 * of the files someone opens. Only the languages `languageOf` names are
 * listed, so the build carries those grammars rather than every one Shiki
 * knows, a few hundred files of them. The regular expressions run on
 * JavaScript's own engine, not Oniguruma's WebAssembly, which costs a few
 * grammar features and half a megabyte less.
 */

import type {
  HighlighterCore,
  LanguageRegistration,
  ThemedToken,
} from "shiki/core";

export type { ThemedToken };

export const THEME = "dark-plus";

/** Past this, a file is shown uncoloured rather than stalling the tab. */
export const HIGHLIGHT_LIMIT_CHARS = 200_000;

type Grammar = () => Promise<{ default: LanguageRegistration[] }>;

/** By the ids `languageOf` in `file-types.ts` gives. */
const GRAMMARS: Readonly<Record<string, Grammar>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  gherkin: () => import("shiki/langs/gherkin.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  make: () => import("shiki/langs/make.mjs"),
};

let highlighter: Promise<HighlighterCore> | undefined;

function load(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
    return createHighlighterCore({
      themes: [import("shiki/themes/dark-plus.mjs")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

/**
 * Each line's tokens, with their colours. Undefined for text the highlighter
 * has no grammar for, or too long to colour; it is shown as it is.
 */
export async function highlightLines(
  text: string,
  language: string,
): Promise<ThemedToken[][] | undefined> {
  if (language === "text" || text.length > HIGHLIGHT_LIMIT_CHARS) {
    return undefined;
  }
  const grammar = Object.hasOwn(GRAMMARS, language)
    ? GRAMMARS[language]
    : undefined;
  if (grammar === undefined) return undefined;
  const core = await load();
  if (!core.getLoadedLanguages().includes(language)) {
    await core.loadLanguage(grammar);
  }
  return core.codeToTokensBase(text, { lang: language, theme: THEME });
}
