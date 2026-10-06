/**
 * The pieces of Visual Studio Code's workbench that more than one viewer
 * draws: file icons, the source view with its line numbers, and a centred
 * note in the editor's place. Inside a `.workbench`, whose colours they use.
 */

import { useLayoutEffect, useRef } from "react";

import { Colored, useHighlighted } from "./Colored";

/**
 * vscode-icons' drawings, written by `scripts/file-icons.mjs`. Files, not
 * inlined: a tree shows a few dozen, and the same few over and over.
 */
const ICON_FILES = import.meta.glob<string>("../../assets/files/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
});
export const ICONS: ReadonlyMap<string, string> = new Map(
  Object.entries(ICON_FILES).map(([path, url]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    url,
  ]),
);

/** A file or folder's icon; decoration, as its name is always beside it. */
export function TypeIcon({ name }: { name: string }) {
  return (
    <img
      src={ICONS.get(name) ?? ICONS.get("default-file")}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
    />
  );
}

/** A note in the editor's place, centred. */
export function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-(--wb-editor) p-6 text-center text-sm text-(--wb-muted)">
      {children}
    </div>
  );
}

/** The source view's line height, in pixels: `leading-[19px]`. */
const LINE_HEIGHT = 19;

/** Text with its line numbers, scrolled together; long lines scroll, not wrap. */
export function Source({
  text,
  language,
  line,
  reveals = 0,
}: {
  text: string;
  language: string;
  /** A line to scroll to and mark. */
  line?: number;
  reveals?: number;
}) {
  const lines = text.endsWith("\n") ? text.slice(0, -1) : text;
  const count = lines === "" ? 1 : lines.split("\n").length;
  const numbers = Array.from({ length: count }, (_, index) => index + 1).join(
    "\n",
  );
  const tokens = useHighlighted(lines, language);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (line === undefined || element === null) return;
    // A third of the way down, where the eye lands, as the editor puts it.
    element.scrollTop = Math.max(
      0,
      (line - 1) * LINE_HEIGHT - element.clientHeight / 3,
    );
  }, [line, reveals]);
  return (
    <div
      ref={scroller}
      className="relative flex min-h-0 flex-1 overflow-auto font-(family-name:--wb-font-code) text-[13px] leading-[19px] text-(--wb-code)"
    >
      {line !== undefined && line <= count && (
        <div
          aria-hidden="true"
          data-testid="revealed-line"
          className="pointer-events-none absolute inset-x-0 border-y border-white/[0.08] bg-white/[0.05]"
          style={{ top: (line - 1) * LINE_HEIGHT, height: LINE_HEIGHT }}
        />
      )}
      <pre
        aria-hidden="true"
        className="sticky left-0 z-10 shrink-0 bg-(--wb-editor) pr-[26px] pl-4 text-right text-(--wb-gutter) select-none"
        style={{ minWidth: `${String(count).length + 4}ch` }}
      >
        {numbers}
      </pre>
      <pre className="flex-1 pr-8 pb-[50vh]" data-testid="file-source">
        <code>
          <Colored text={lines} tokens={tokens} />
        </code>
      </pre>
    </div>
  );
}
