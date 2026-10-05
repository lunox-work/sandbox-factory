/**
 * Text in the editor's colours, for the source view and for a code block in
 * a rendered document alike.
 */

import { Fragment, useEffect, useState } from "react";

import { highlightLines, type ThemedToken } from "./highlight";

/** `FontStyle` in Shiki: bit flags on each token. */
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/**
 * The text's tokens with their colours, once the highlighter has them; until
 * then, and for a language it does not know, undefined.
 */
export function useHighlighted(text: string, language: string) {
  const [result, setResult] = useState<{
    text: string;
    language: string;
    lines: ThemedToken[][] | undefined;
  } | null>(null);
  useEffect(() => {
    let current = true;
    highlightLines(text, language).then(
      (lines) => {
        if (current) setResult({ text, language, lines });
      },
      // Uncoloured text is still the file.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [text, language]);
  return result?.text === text && result.language === language
    ? result.lines
    : undefined;
}

/**
 * The text as its tokens, one line after another, or as it is until they
 * arrive. Either way its text content is the text, unchanged.
 */
export function Colored({
  text,
  tokens,
}: {
  text: string;
  tokens: ThemedToken[][] | undefined;
}) {
  if (tokens === undefined) return text;
  return tokens.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && "\n"}
      {line.map((token, at) => {
        const style = token.fontStyle ?? 0;
        return (
          <span
            key={at}
            style={{
              color: token.color,
              fontStyle: style & ITALIC ? "italic" : undefined,
              fontWeight: style & BOLD ? "bold" : undefined,
              textDecoration: style & UNDERLINE ? "underline" : undefined,
            }}
          >
            {token.content}
          </span>
        );
      })}
    </Fragment>
  ));
}
