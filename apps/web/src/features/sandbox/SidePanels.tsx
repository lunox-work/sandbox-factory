/**
 * The sidebar's views beside the explorer: search across every file's text,
 * the version's documents, and its tests down to each case. Each opens what
 * it lists in the editor, at the line when it names one.
 */

import type { SandboxFileDto } from "@sandbox-factory/shared";
import {
  CaseSensitive,
  ChevronRight,
  FlaskConical,
  ListTree,
  Lock,
} from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { isPlainLeftClick } from "../../routes";
import { useFileTexts, type FileSource } from "./file-content";
import { fileIconName } from "./file-types";
import { parseFeature, scenarioCount } from "./gherkin";
import {
  byFolder,
  isFeature,
  isMarkdown,
  isTestFile,
  searchLines,
  testCases,
} from "./outline";

/** Opens a file in the editor, at a line when one is given. */
type OpenFile = (path: string, line?: number) => void;

interface PanelProps {
  /** Whether the view is the one showing; a hidden one reads nothing. */
  active: boolean;
  files: readonly SandboxFileDto[];
  source: FileSource;
  selected: string | null;
  href: (path: string) => string;
  onOpen: OpenFile;
}

/** The folder that holds the hidden tests. */
const PRIVATE_FOLDER = "private";

/** Files a search never reads: their content is not text. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot)$/i;

/** How much of a line a search result shows before its match. */
const LEAD = 24;

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A link to a file that opens it in place, at a line when given. */
function FileLink({
  path,
  line,
  href,
  onOpen,
  className,
  children,
  current,
}: {
  path: string;
  line?: number;
  href: (path: string) => string;
  onOpen: OpenFile;
  className?: string;
  children: React.ReactNode;
  current?: boolean;
}) {
  return (
    <a
      href={href(path)}
      aria-current={current === true ? "page" : undefined}
      className={cn(
        "focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
        className,
      )}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onOpen(path, line);
      }}
    >
      {children}
    </a>
  );
}

function FileIcon({ name, url }: { name: string; url: IconUrl }) {
  return (
    <img
      src={url(fileIconName(name))}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
    />
  );
}

/** The url of a vscode-icons drawing, by its name. */
type IconUrl = (name: string) => string | undefined;

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-1 text-xs text-(--wb-muted)">{children}</p>;
}

/**
 * A view's section header, as the editor heads a pane: the explorer's
 * "VERSION 3", the outline's, at the row height and in the row's own left
 * padding, so what it heads lines up under it.
 */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="flex h-[22px] shrink-0 items-center truncate pr-3 pl-5 text-[11px] font-bold tracking-wide text-(--wb-muted) uppercase">
      {children}
    </h3>
  );
}

/**
 * A row of a view, as the explorer draws a file: the editor's 22px, the
 * cursor's fill under it, and the chosen one's fill held. Not a card: the
 * editor's side views are trees of rows, and a stack of bordered boxes in
 * a sidebar reads as a web page's, not an editor's.
 */
export const row =
  "flex h-[22px] w-full min-w-0 items-center gap-1.5 pr-3 pl-5 text-left whitespace-nowrap hover:bg-(--wb-hover)";
export const currentRow =
  "bg-(--wb-selected) text-(--wb-strong) hover:bg-(--wb-selected)";

/** A count at a row's right edge, in the gutter's quiet figures. */
export const rowCount =
  "ml-auto shrink-0 pl-2 text-[11px] text-(--wb-muted) tabular-nums";

export function SearchPanel({
  active,
  files,
  source,
  href,
  onOpen,
  iconUrl,
}: PanelProps & { iconUrl: IconUrl }) {
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);

  const paths = useMemo(
    () =>
      files.filter(({ path }) => !BINARY.test(path)).map(({ path }) => path),
    [files],
  );
  // Read once there is something to look for, and kept for the next.
  const [wanted, setWanted] = useState(false);
  if (active && query !== "" && !wanted) setWanted(true);
  const { texts, pending } = useFileTexts(source, paths, wanted);

  // Searched behind the typing: every file is scanned for each query, and
  // the field should not wait for that.
  const searched = useDeferredValue(query);
  const results = useMemo(
    () =>
      paths.flatMap((path) => {
        const text = texts.get(path);
        if (text === undefined || text === null) return [];
        const matches = searchLines(text, searched, matchCase);
        return matches.length === 0 ? [] : [{ path, matches }];
      }),
    [paths, texts, searched, matchCase],
  );
  const total = results.reduce((sum, { matches }) => sum + matches.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <div className="flex h-[26px] items-center rounded-[4px] border border-(--wb-input-border) bg-(--wb-input) focus-within:border-(--wb-accent)">
          <input
            ref={input}
            type="search"
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent px-[7px] text-[13px] text-(--wb-strong) outline-none placeholder:text-(--wb-muted)"
          />
          <button
            type="button"
            aria-label="Match case"
            aria-pressed={matchCase}
            title="Match Case"
            onClick={() => setMatchCase((value) => !value)}
            className={cn(
              "mr-0.5 flex size-5 items-center justify-center rounded-[4px] text-(--wb-muted) hover:bg-(--wb-hover)",
              matchCase &&
                "border border-(--wb-accent) bg-(--wb-accent)/25 text-(--wb-strong)",
            )}
          >
            <CaseSensitive aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      {query !== "" && (
        <p role="status" className="px-5 pb-1 text-xs text-(--wb-muted)">
          {total === 0 && pending === 0
            ? "No results found."
            : `${total} ${total === 1 ? "result" : "results"} in ${results.length} ${results.length === 1 ? "file" : "files"}`}
          {pending > 0 && ` · reading ${pending} more…`}
        </p>
      )}
      <ul
        aria-label="Search results"
        className="min-h-0 flex-1 overflow-auto pb-4"
      >
        {results.map(({ path, matches }) => {
          const open = !collapsed.has(path);
          const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
          return (
            <li key={path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                  const next = new Set(collapsed);
                  if (open) next.add(path);
                  else next.delete(path);
                  setCollapsed(next);
                }}
                className="flex h-[22px] w-full items-center gap-1.5 pr-3 pl-3 text-left whitespace-nowrap hover:bg-(--wb-hover)"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn("size-4 shrink-0", open && "rotate-90")}
                />
                <FileIcon name={nameOf(path)} url={iconUrl} />
                <span className="shrink-0">{nameOf(path)}</span>
                <span className="min-w-0 truncate text-xs text-(--wb-muted)">
                  {folder}
                </span>
                <span className="ml-auto shrink-0 rounded-full bg-(--wb-selected) px-1.5 text-[11px] leading-4 tabular-nums">
                  {matches.length}
                </span>
              </button>
              {open && (
                <ul>
                  {matches.map((match) => (
                    <li key={match.line}>
                      <FileLink
                        path={path}
                        line={match.line}
                        href={href}
                        onOpen={onOpen}
                        className="flex h-[22px] items-center overflow-hidden pr-3 pl-[34px] whitespace-nowrap hover:bg-(--wb-hover)"
                      >
                        <span className="truncate">
                          {/* Far into a long line, the match is kept in
                              sight with a little of what leads to it. */}
                          {match.start > LEAD
                            ? `…${match.text.slice(match.start - LEAD + 4, match.start)}`
                            : match.text.slice(0, match.start)}
                          <mark className="rounded-[2px] bg-[#ea5c00]/35 text-(--wb-strong)">
                            {match.text.slice(match.start, match.end)}
                          </mark>
                          {match.text.slice(match.end)}
                        </span>
                      </FileLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DocsPanel({
  active,
  files,
  source,
  selected,
  href,
  onOpen,
  iconUrl,
  bounty,
  spec,
}: PanelProps & {
  iconUrl: IconUrl;
  /** The bounty the version was cut for, ahead of everything. */
  bounty?: React.ReactNode;
  /**
   * What the version has besides its files: listed after its documents and
   * before its features, beside the scenarios those are written as.
   */
  spec?: React.ReactNode;
}) {
  const features = useMemo(
    () => files.filter(({ path }) => isFeature(path)).map(({ path }) => path),
    [files],
  );
  const documents = useMemo(
    () => files.filter(({ path }) => isMarkdown(path)).map(({ path }) => path),
    [files],
  );
  const { texts } = useFileTexts(source, features, active);

  if (
    bounty === undefined &&
    spec === undefined &&
    features.length === 0 &&
    documents.length === 0
  )
    return <Hint>This version has no documents.</Hint>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-4">
      {bounty}
      {byFolder(documents, (path) => path).map(([folder, paths]) => (
        <section key={folder} aria-label={folder || "Top level"}>
          <SectionLabel>{folder || "Top level"}</SectionLabel>
          <ul>
            {paths.map((path) => (
              <li key={path}>
                <FileLink
                  path={path}
                  href={href}
                  onOpen={onOpen}
                  current={path === selected}
                  className={cn(row, path === selected && currentRow)}
                >
                  <FileIcon name={nameOf(path)} url={iconUrl} />
                  <span className="truncate">{nameOf(path)}</span>
                </FileLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {spec}
      {features.length > 0 && (
        <section aria-label="Features">
          <SectionLabel>Features</SectionLabel>
          <ul>
            {features.map((path) => {
              const text = texts.get(path);
              const feature =
                text === undefined || text === null
                  ? undefined
                  : parseFeature(text);
              const count =
                feature === undefined ? undefined : scenarioCount(feature);
              return (
                <li key={path}>
                  <FileLink
                    path={path}
                    href={href}
                    onOpen={onOpen}
                    current={path === selected}
                    className={cn(row, path === selected && currentRow)}
                  >
                    <FileIcon name={nameOf(path)} url={iconUrl} />
                    <span className="truncate" title={path}>
                      {feature?.name || nameOf(path).replace(/\.feature$/i, "")}
                    </span>
                    {count !== undefined && (
                      <span className={rowCount}>
                        {count} {count === 1 ? "scenario" : "scenarios"}
                      </span>
                    )}
                  </FileLink>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

export function TestsPanel({
  active,
  files,
  source,
  selected,
  href,
  onOpen,
  iconUrl,
  summary,
}: PanelProps & {
  iconUrl: IconUrl;
  /** What the version says its tests cover, by label. */
  summary: readonly { label: string; count: number }[];
}) {
  const tests = useMemo(
    () => files.filter(({ path }) => isTestFile(path)).map(({ path }) => path),
    [files],
  );
  const { texts } = useFileTexts(source, tests, active);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const hiddenTests = tests.filter((path) =>
    path.startsWith(`${PRIVATE_FOLDER}/`),
  );
  const groups = [
    ...(hiddenTests.length === 0
      ? []
      : [{ label: "Hidden", hidden: true, paths: hiddenTests }]),
    ...byFolder(
      tests.filter((path) => !path.startsWith(`${PRIVATE_FOLDER}/`)),
      (path) => path,
    ).map(([folder, paths]) => ({
      label: folder || "Top level",
      hidden: false,
      paths,
    })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pb-4">
      {summary.length > 0 && (
        <section aria-label="Summary">
          <SectionLabel>Summary</SectionLabel>
          <ul>
            {summary.map(({ label, count }) => (
              <li key={label} className={row}>
                <span className="min-w-0 truncate">{label}</span>
                <span className={rowCount}>{count}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {groups.length === 0 && <Hint>This version has no test files.</Hint>}
      {groups.map(({ label, hidden, paths }) => (
        <section key={label} aria-label={label}>
          <SectionLabel>
            <span className="flex items-center gap-1">
              {label}
              {hidden && (
                <Lock
                  aria-label="hidden from contributors"
                  className="size-3"
                />
              )}
            </span>
          </SectionLabel>
          <ul>
            {paths.map((path) => {
              const text = texts.get(path);
              const cases =
                text === undefined || text === null
                  ? undefined
                  : isFeature(path)
                    ? parseFeature(text)
                        .scenarios.filter(({ kind }) => kind !== "background")
                        .map(({ name, line }) => ({ name, line, group: false }))
                    : testCases(text);
              const open = !collapsed.has(path);
              const count = cases?.filter(({ group }) => !group).length;
              return (
                <li key={path}>
                  {/* A folder's row in the explorer: the chevron, then the
                      file, one fill under both. */}
                  <div
                    className={cn(
                      "flex h-[22px] items-center pr-3 pl-3 hover:bg-(--wb-hover)",
                      path === selected && currentRow,
                    )}
                  >
                    <button
                      type="button"
                      aria-label={`${open ? "Hide" : "Show"} the tests in ${nameOf(path)}`}
                      aria-expanded={open}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (open) next.add(path);
                        else next.delete(path);
                        setCollapsed(next);
                      }}
                      className="flex h-full w-[22px] shrink-0 items-center focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn("size-4", open && "rotate-90")}
                      />
                    </button>
                    <FileLink
                      path={path}
                      href={href}
                      onOpen={onOpen}
                      current={path === selected}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap"
                    >
                      <FileIcon name={nameOf(path)} url={iconUrl} />
                      <span className="truncate">{nameOf(path)}</span>
                      {count !== undefined && (
                        <span className={rowCount}>
                          {count} {count === 1 ? "test" : "tests"}
                        </span>
                      )}
                    </FileLink>
                  </div>
                  {open && cases !== undefined && cases.length > 0 && (
                    <ul>
                      {cases.map(({ name, line, group }) => (
                        <li key={line}>
                          <FileLink
                            path={path}
                            line={line}
                            href={href}
                            onOpen={onOpen}
                            className={cn(
                              row,
                              "pl-[42px]",
                              group && "text-(--wb-muted)",
                            )}
                          >
                            {group ? (
                              <ListTree
                                aria-hidden="true"
                                className="size-3.5 shrink-0"
                              />
                            ) : (
                              <FlaskConical
                                aria-hidden="true"
                                className="size-3.5 shrink-0 text-[#89d185]"
                              />
                            )}
                            <span className="min-w-0 truncate">{name}</span>
                          </FileLink>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
