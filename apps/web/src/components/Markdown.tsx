import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed" data-testid="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => (
            <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{c}</h4>
          ),
          h2: ({ children: c }) => (
            <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{c}</h4>
          ),
          h3: ({ children: c }) => (
            <h5 className="mt-3 mb-1 text-sm font-medium first:mt-0">{c}</h5>
          ),
          p: ({ children: c }) => <p className="my-2">{c}</p>,
          ul: ({ children: c }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{c}</ul>
          ),
          ol: ({ children: c }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{c}</ol>
          ),
          // A task list renders its own checkbox, so the disc would be a
          // second marker for the same item.
          li: ({ children: c, ...rest }) =>
            "checked" in rest && rest.checked !== null ? (
              <li className="list-none">{c}</li>
            ) : (
              <li>{c}</li>
            ),
          input: ({ checked }) => (
            // Disabled, not read-only: the state belongs to Jira, and a box
            // that looks clickable here would be a lie.
            <input
              type="checkbox"
              checked={checked ?? false}
              disabled
              readOnly
              className="mr-2 align-middle"
            />
          ),
          code: ({ className, children: c }) =>
            className?.startsWith("language-") === true ? (
              <code className="block">{c}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                {c}
              </code>
            ),
          pre: ({ children: c }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {c}
            </pre>
          ),
          blockquote: ({ children: c }) => (
            <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">
              {c}
            </blockquote>
          ),
          hr: () => <hr className="my-3" />,
          a: ({ href, children: c }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              {c}
            </a>
          ),
          table: ({ children: c }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{c}</table>
            </div>
          ),
          th: ({ children: c }) => (
            <th className="border px-2 py-1 text-left font-medium">{c}</th>
          ),
          td: ({ children: c }) => <td className="border px-2 py-1">{c}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A labelled row in a property list. Renders nothing when there is no value,
 * so a record with sparse fields reads as a short list rather than a column
 * of empty labels.
 */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  if (children === null || children === undefined || children === "") {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:gap-3">
      <span className="shrink-0 text-muted-foreground sm:w-32">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
