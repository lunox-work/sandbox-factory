/**
 * A Markdown file as a document to read, the way a docs pane shows it rather
 * than as its source: a centred column, its headings, lists and tables laid
 * out, its code blocks in the editor's colours.
 *
 * Links and inline code that name a file in the sandbox open that file in
 * the editor, so a README's `src/app.ts` is one click from the code.
 */

import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import { Colored, useHighlighted } from "./Colored";
import { linkedFile } from "./file-tree";
import { languageOf } from "./file-types";

/** The text of a parsed node and everything in it. */
function textOf(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(textOf).join("");
  }
  return "";
}

/** A fence's language, `sh` or `ts`, as the highlighter names it. */
function fenceLanguage(node: unknown): string {
  const code =
    typeof node === "object" &&
    node !== null &&
    "children" in node &&
    Array.isArray(node.children)
      ? (node.children[0] as unknown)
      : undefined;
  const classes =
    typeof code === "object" &&
    code !== null &&
    "properties" in code &&
    typeof code.properties === "object" &&
    code.properties !== null &&
    "className" in code.properties &&
    Array.isArray(code.properties.className)
      ? (code.properties.className as unknown[])
      : [];
  const named = classes
    .map(String)
    .find((name) => name.startsWith("language-"))
    ?.slice("language-".length)
    .toLowerCase();
  if (named === undefined) return "text";
  const byExtension = languageOf(`file.${named}`).id;
  return byExtension === "text" ? named : byExtension;
}

function CodeBlock({ text, language }: { text: string; language: string }) {
  const code = text.endsWith("\n") ? text.slice(0, -1) : text;
  const tokens = useHighlighted(code, language);
  return (
    <pre className="my-4 overflow-x-auto rounded-md border border-(--wb-border) bg-(--wb-chrome) px-4 py-3 font-(family-name:--wb-font-code) text-[13px] leading-[19px] text-(--wb-code)">
      <code>
        <Colored text={code} tokens={tokens} />
      </code>
    </pre>
  );
}

export function MarkdownDocument({
  text,
  path,
  paths,
  onOpen,
  href,
}: {
  text: string;
  /** The file's own path, which its relative links start from. */
  path: string;
  /** Every file in the sandbox, which a link may name. */
  paths: readonly string[];
  href: (path: string) => string;
  onOpen: (path: string) => (event: React.MouseEvent) => void;
}) {
  const fileLink = (target: string, children: ReactNode, className: string) => {
    const file = linkedFile(paths, path, target);
    return file === undefined ? undefined : (
      <a
        href={href(file)}
        title={file}
        onClick={onOpen(file)}
        className={className}
      >
        {children}
      </a>
    );
  };
  const link =
    "text-[#4daafc] underline-offset-2 hover:underline focus-visible:outline-1 focus-visible:outline-(--wb-accent)";
  const inlineCode =
    "rounded-[3px] bg-white/[0.07] px-1 py-px font-(family-name:--wb-font-code) text-[0.9em] text-[#d7ba7d]";

  return (
    <div
      className="min-h-0 flex-1 overflow-auto"
      data-testid="markdown-document"
    >
      <article className="mx-auto max-w-[52rem] px-8 pt-6 pb-[40vh] text-[14px] leading-[1.65] text-(--wb-foreground) sm:px-12">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 className="mt-6 mb-4 border-b border-(--wb-border) pb-2 text-[2em] leading-tight font-semibold text-(--wb-strong) first:mt-0">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 className="mt-8 mb-3 border-b border-(--wb-border) pb-1.5 text-[1.5em] leading-tight font-semibold text-(--wb-strong) first:mt-0">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-6 mb-2 text-[1.17em] font-semibold text-(--wb-strong) first:mt-0">
                {children}
              </h3>
            ),
            h4: ({ children }) => (
              <h4 className="mt-5 mb-2 font-semibold text-(--wb-strong)">
                {children}
              </h4>
            ),
            p: ({ children }) => <p className="my-3">{children}</p>,
            ul: ({ children }) => (
              <ul className="my-3 list-disc space-y-1 pl-6 marker:text-(--wb-gutter)">
                {children}
              </ul>
            ),
            ol: ({ children }) => (
              <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-(--wb-gutter)">
                {children}
              </ol>
            ),
            li: ({ children, ...rest }) =>
              "checked" in rest && rest.checked !== null ? (
                <li className="list-none">{children}</li>
              ) : (
                <li>{children}</li>
              ),
            input: ({ checked }) => (
              <input
                type="checkbox"
                checked={checked ?? false}
                disabled
                readOnly
                className="mr-2 -ml-5 align-middle"
              />
            ),
            blockquote: ({ children }) => (
              <blockquote className="my-4 border-l-4 border-(--wb-input-border) pl-4 text-(--wb-muted)">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="my-6 border-(--wb-border)" />,
            a: ({ href: target = "", children }) =>
              fileLink(target, children, link) ?? (
                <a
                  href={target}
                  target={target.startsWith("#") ? undefined : "_blank"}
                  rel="noreferrer noopener"
                  className={link}
                >
                  {children}
                </a>
              ),
            // Not fetched: the sandbox's files are read one at a time, and
            // an image is not text. Its description stands in.
            img: ({ alt }) => (
              <span className="text-(--wb-muted) italic">
                {alt === undefined || alt === "" ? "[image]" : `[${alt}]`}
              </span>
            ),
            pre: ({ node }) => (
              <CodeBlock text={textOf(node)} language={fenceLanguage(node)} />
            ),
            code: ({ children }) => {
              const named = textOf({ children: [{ value: String(children) }] });
              const looksLikePath =
                !/\s/.test(named) && /[./]/.test(named) && named.length < 200;
              return (
                (looksLikePath &&
                  fileLink(
                    named,
                    <code className={inlineCode}>{children}</code>,
                    "hover:underline decoration-[#d7ba7d] underline-offset-2",
                  )) || <code className={inlineCode}>{children}</code>
              );
            },
            table: ({ children }) => (
              <div className="my-4 overflow-x-auto">
                <table className="border-collapse text-[13px]">
                  {children}
                </table>
              </div>
            ),
            th: ({ children }) => (
              <th className="border border-(--wb-input-border) bg-white/[0.04] px-3 py-1.5 text-left font-semibold">
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td className="border border-(--wb-input-border) px-3 py-1.5">
                {children}
              </td>
            ),
            strong: ({ children }) => (
              <strong className={cn("font-semibold text-(--wb-strong)")}>
                {children}
              </strong>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </article>
    </div>
  );
}
