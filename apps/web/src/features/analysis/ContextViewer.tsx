/**
 * What the context builders wrote at the repository's one context commit, in a dialog drawn as
 * the sandbox page's workbench is: an explorer with a folder for each
 * builder that has built, marked with the builder's icon, and the open
 * file beside it.
 *
 * Files are read as text through the API, highlighted as the sandbox's
 * are. What can be seen opens shown, with a toggle back to the text as
 * written: Markdown as a document, its Mermaid fences drawn; Mermaid and
 * Graphviz files as diagrams to pan and zoom; a web page, Graphify's graph,
 * running in a frame apart from this page; an SVG as a picture; JSON laid
 * out. Anything else too large or not text opens through its signed URL.
 */

import type { AnalysisRunDto, ArtifactDto } from "@sandbox-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  BookOpen,
  Braces,
  ChevronRight,
  ExternalLink,
  Files,
  Image,
  RefreshCw,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ContextBuilder } from "sandbox-factory";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients, queryKeys, useUserId } from "../../data/query";
import {
  fileTree,
  foldersOf,
  sizeLabel,
  type TreeNode,
} from "../sandbox/file-tree";
import {
  fileIconName,
  folderIconName,
  languageOf,
} from "../sandbox/file-types";
import { DiagramView, SvgPicture } from "../sandbox/Diagram";
import { diagramKind } from "../sandbox/diagrams";
import { formatJson } from "../sandbox/json-format";
import { MarkdownDocument } from "../sandbox/MarkdownDocument";
import { Centered, Source, TypeIcon } from "../sandbox/workbench";
import { BUILDER_DETAILS } from "./BuilderRow";
import { builderNames } from "./labels";
import { Panes, Watermark, WorkbenchDialog } from "./WorkbenchDialog";

/** A builder's succeeded run on the snapshot, and what it wrote. */
export interface ContextBuild {
  builder: ContextBuilder;
  run: AnalysisRunDto;
  /** Undefined while they are read, and when the read failed. */
  artifacts: readonly ArtifactDto[] | undefined;
  /** The read of its artifacts failed. */
  failed?: boolean;
}

/** A file in the explorer: `<builder>/<artifact path>`. */
interface Entry {
  build: ContextBuild;
  artifact: ArtifactDto;
}

export function ContextViewer({
  owner,
  commit,
  builds,
  onRetry,
  open,
  onOpenChange,
  onOpenRaw,
  notice,
}: {
  owner: string;
  /** The context's commit, short, for the title. */
  commit: string | undefined;
  /** In the builders' order. */
  builds: readonly ContextBuild[];
  /** Reads again the builds whose files could not be listed. */
  onRetry?: (() => void) | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens an artifact's signed URL in a new tab. */
  onOpenRaw: (artifactId: string) => void;
  /** A failure from inside the dialog; see `WorkbenchDialog`. */
  notice?: { text: string; onDismiss: () => void } | null | undefined;
}) {
  return (
    <WorkbenchDialog
      notice={notice}
      title="Context"
      detail={commit}
      description="The files each context builder wrote at this commit."
      open={open}
      onOpenChange={onOpenChange}
    >
      <Workbench
        owner={owner}
        builds={builds}
        onRetry={onRetry}
        onOpenRaw={onOpenRaw}
      />
    </WorkbenchDialog>
  );
}

function Workbench({
  owner,
  builds,
  onRetry,
  onOpenRaw,
}: {
  owner: string;
  builds: readonly ContextBuild[];
  onRetry?: (() => void) | undefined;
  onOpenRaw: (artifactId: string) => void;
}) {
  const entries = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const build of builds)
      for (const artifact of build.artifacts ?? [])
        map.set(`${build.builder}/${artifact.path}`, { build, artifact });
    return map;
  }, [builds]);
  const keys = useMemo(() => [...entries.keys()], [entries]);
  /*
    The first document opens, if there is one: it reads as written for
    people, where a graph's JSON is for tools.
  */
  const [chosen, setChosen] = useState<string | null>(null);
  const selected =
    chosen ?? keys.find((key) => languageOf(key).id === "markdown") ?? null;
  const entry = selected === null ? undefined : entries.get(selected);
  const reading = builds.some(
    (build) => build.artifacts === undefined && build.failed !== true,
  );
  const failed = builds.filter((build) => build.failed === true);

  return (
    <Panes
      sidebarTitle="Explorer"
      sidebar={
        <>
          <Explorer builds={builds} selected={selected} onOpen={setChosen} />
          {reading && (
            <div className="px-5 py-2 text-xs text-(--wb-muted)">
              <LoadingLine>Listing files…</LoadingLine>
            </div>
          )}
          {failed.length > 0 && (
            <p className="px-5 py-2 text-xs text-(--wb-muted)">
              {failed.length === 1
                ? `${builderNames[failed[0]?.builder ?? "graphify"]}'s files could not be listed.`
                : "Some builds' files could not be listed."}{" "}
              {onRetry !== undefined && (
                <button
                  type="button"
                  className="text-(--wb-accent) hover:underline"
                  onClick={onRetry}
                >
                  Try again
                </button>
              )}
            </p>
          )}
        </>
      }
    >
      {entry === undefined ? (
        <Watermark icon={Files}>
          Open a file from the explorer to read it.
        </Watermark>
      ) : (
        <Viewer
          key={selected}
          owner={owner}
          path={selected ?? ""}
          entry={entry}
          paths={keys}
          onOpen={setChosen}
          onOpenRaw={onOpenRaw}
        />
      )}
    </Panes>
  );
}

function Explorer({
  builds,
  selected,
  onOpen,
}: {
  builds: readonly ContextBuild[];
  selected: string | null;
  onOpen: (path: string) => void;
}) {
  // The builders whose files are not known yet: being read, or not read.
  const unread = new Set(
    builds
      .filter(({ artifacts }) => artifacts === undefined)
      .map(({ builder }) => builder as string),
  );
  // A folder for each builder, in the builders' order, with its files in it.
  const tree = useMemo(
    () =>
      builds.map(({ builder, artifacts }): TreeNode => ({
        kind: "folder",
        name: builderNames[builder],
        path: builder,
        children: fileTree(
          (artifacts ?? []).map(({ path, sizeBytes }) => ({
            path: `${builder}/${path}`,
            sizeBytes,
          })),
        ).flatMap((node) => (node.kind === "folder" ? node.children : [])),
      })),
    [builds],
  );
  /*
    Each builder's folder open from the start, and those around the open
    file, which may only be known once the files are listed; nothing closes
    until someone closes it.
  */
  const [folders, setFolders] = useState<{
    revealed: string | null;
    expanded: ReadonlySet<string>;
  }>(() => ({
    revealed: selected,
    expanded: new Set([
      ...builds.map(({ builder }) => builder),
      ...(selected === null ? [] : foldersOf(selected)),
    ]),
  }));
  let { expanded } = folders;
  if (folders.revealed !== selected) {
    expanded = new Set([
      ...expanded,
      ...(selected === null ? [] : foldersOf(selected)),
    ]);
    setFolders({ revealed: selected, expanded });
  }
  const setExpanded = (next: ReadonlySet<string>) =>
    setFolders({ revealed: selected, expanded: next });
  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  };

  const row =
    "relative flex h-[22px] w-full items-center gap-1.5 pr-3 text-left whitespace-nowrap hover:bg-(--wb-hover) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)";
  const indent = (depth: number) => depth * 8 + 12;

  const render = (nodes: readonly TreeNode[], depth: number) => (
    <ul role={depth === 0 ? undefined : "group"}>
      {nodes.map((node) => {
        if (node.kind === "folder") {
          const isOpen = expanded.has(node.path);
          return (
            <li key={node.path}>
              <button
                type="button"
                className={row}
                style={{ paddingLeft: `${indent(depth)}px` }}
                aria-expanded={isOpen}
                onClick={() => toggle(node.path)}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-(--wb-foreground)",
                    isOpen && "rotate-90",
                  )}
                />
                {depth === 0 ? (
                  <BuilderIcon builder={node.path as ContextBuilder} />
                ) : (
                  <TypeIcon name={folderIconName(node.name, isOpen)} />
                )}
                <span className="truncate">{node.name}</span>
              </button>
              {isOpen &&
                // A builder still being read, or whose read failed, is not
                // known to have no files; the line under the tree says so.
                !(depth === 0 && unread.has(node.path)) &&
                (node.children.length === 0 ? (
                  <p
                    className="h-[22px] pr-3 leading-[22px] whitespace-nowrap text-(--wb-muted) italic"
                    style={{ paddingLeft: `${indent(depth + 1) + 22}px` }}
                  >
                    No files
                  </p>
                ) : (
                  render(node.children, depth + 1)
                ))}
            </li>
          );
        }
        const current = node.path === selected;
        return (
          <li key={node.path}>
            <button
              type="button"
              aria-current={current ? "true" : undefined}
              title={node.path.slice(node.path.indexOf("/") + 1)}
              className={cn(
                row,
                current &&
                  "bg-(--wb-selected) text-(--wb-strong) hover:bg-(--wb-selected)",
              )}
              // The chevron's width and gap, so a file lines up with a
              // folder's name.
              style={{ paddingLeft: `${indent(depth) + 22}px` }}
              onClick={() => onOpen(node.path)}
            >
              <TypeIcon name={fileIconName(node.name)} />
              <span className="truncate">{node.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav aria-label="Files" className="min-h-0 flex-1 overflow-auto pb-4">
      {render(tree, 0)}
    </nav>
  );
}

/** A builder's folder, marked as its row on the page is. */
function BuilderIcon({ builder }: { builder: ContextBuilder }) {
  const { icon: Icon } = BUILDER_DETAILS[builder];
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-[#75beff]" />;
}

/** A file shown as it reads best, and the toggle that shows it. */
interface Rendering {
  label: string;
  icon: LucideIcon;
  title: string;
  view: React.ReactNode;
}

/** The part of a name after its last dot, lower case: `html`, `mmd`. */
function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * A web page a builder wrote, such as Graphify's interactive graph, run in
 * a sandboxed frame: its scripts run, but in an origin of its own, so they
 * reach neither this page nor its session. One too large to read as text
 * loads from its signed URL.
 */
function WebPage({
  owner,
  artifact,
  text,
}: {
  owner: string;
  artifact: ArtifactDto;
  text: string | null;
}) {
  const userId = useUserId();
  const url = useQuery({
    queryKey: queryKeys.resource(
      userId,
      owner,
      "analysis-artifact-url",
      artifact.id,
    ),
    queryFn: ({ signal }) =>
      clients.analysis.artifactUrl(owner, artifact.id, signal),
    enabled: text === null,
    // Signed for fifteen minutes; the frame reads it once, on load.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const source = text ?? url.data;
  /** The source the frame last finished loading, scripts and all. */
  const [loaded, setLoaded] = useState<string | undefined>(undefined);
  if (text === null && url.isPending)
    return (
      <Centered>
        <LoadingLine>Opening {artifact.path}…</LoadingLine>
      </Centered>
    );
  if (text === null && url.isError)
    return (
      <Centered>
        <ErrorBanner className="mt-0">
          This page could not be opened.
        </ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void url.refetch()}
        >
          <RefreshCw />
          Try again
        </Button>
      </Centered>
    );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        title={artifact.path}
        // Scripts, and nothing else: no same origin, no forms, no popups,
        // no navigating this page.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        {...(text !== null ? { srcDoc: text } : { src: url.data })}
        onLoad={() => setLoaded(source)}
        className="min-h-0 w-full flex-1 border-0 bg-white"
      />
      {/* A page's own scripts may run for seconds before it draws, as
          Graphify's graph lays itself out; its load event waits for them. */}
      {loaded !== source && (
        <div className="absolute inset-0 flex">
          <Centered>
            <LoadingLine>Drawing {artifact.path}…</LoadingLine>
          </Centered>
        </div>
      )}
    </div>
  );
}

function Viewer({
  owner,
  path,
  entry,
  paths,
  onOpen,
  onOpenRaw,
}: {
  owner: string;
  /** The explorer's key for it: `<builder>/<artifact path>`. */
  path: string;
  entry: Entry;
  /** Every file in the explorer, which a document's links may name. */
  paths: readonly string[];
  onOpen: (path: string) => void;
  onOpenRaw: (artifactId: string) => void;
}) {
  const userId = useUserId();
  const { artifact, build } = entry;
  const content = useQuery({
    queryKey: queryKeys.resource(
      userId,
      owner,
      "analysis-artifact-content",
      artifact.id,
    ),
    queryFn: ({ signal }) =>
      clients.analysis.artifactContent(owner, artifact.id, signal),
    // A run's output does not change once written.
    staleTime: Infinity,
  });
  const language = languageOf(artifact.path).id;
  const text = content.data?.text ?? null;
  const formatted = useMemo(() => {
    if (language !== "json" || text === null) return undefined;
    const laidOut = formatJson(text);
    return laidOut === undefined || laidOut === text.trimEnd()
      ? undefined
      : laidOut;
  }, [language, text]);
  const extension = extensionOf(artifact.path);
  const diagram = diagramKind(extension);
  const page =
    (extension === "html" || extension === "htm") &&
    (text !== null || content.data?.omitted === "too_large");
  const rendering: Rendering | undefined = page
    ? {
        label: "Preview",
        icon: AppWindow,
        title: "Running as a web page.",
        view: <WebPage owner={owner} artifact={artifact} text={text} />,
      }
    : text === null
      ? undefined
      : diagram !== undefined
        ? {
            label: "Preview",
            icon: Workflow,
            title: "Drawn as a diagram.",
            view: (
              <DiagramView kind={diagram} source={text} label={artifact.path} />
            ),
          }
        : extension === "svg"
          ? {
              label: "Preview",
              icon: Image,
              title: "Shown as a picture.",
              view: <SvgPicture text={text} label={artifact.path} />,
            }
          : language === "markdown"
            ? {
                label: "Preview",
                icon: BookOpen,
                title: "Rendered as a document.",
                view: (
                  <MarkdownDocument
                    text={text}
                    path={path}
                    paths={paths}
                    href={(target) => `#${target}`}
                    onOpen={(target) => (event) => {
                      event.preventDefault();
                      onOpen(target);
                    }}
                  />
                ),
              }
            : formatted !== undefined
              ? {
                  label: "Format JSON",
                  icon: Braces,
                  title: "Formatted for reading.",
                  view: <Source text={formatted} language={language} />,
                }
              : undefined;
  const [asWritten, setAsWritten] = useState(false);
  // A page too large to read as text is shown, with nothing to toggle to.
  const showRendered = rendering !== undefined && (!asWritten || text === null);

  let body: React.ReactNode;
  if (content.isPending)
    body = (
      <Centered>
        <LoadingLine>Reading {artifact.path}…</LoadingLine>
      </Centered>
    );
  else if (content.isError)
    body = (
      <Centered>
        <ErrorBanner className="mt-0">This file could not be read.</ErrorBanner>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void content.refetch()}
        >
          <RefreshCw />
          Try again
        </Button>
      </Centered>
    );
  else if (showRendered) body = rendering.view;
  else if (content.data.text === null)
    body = (
      <Centered>
        {content.data.omitted === "too_large"
          ? `This file is ${sizeLabel(artifact.sizeBytes)}, too large to show here.`
          : "This file is not text, so it is not shown here."}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenRaw(artifact.id)}
        >
          <ExternalLink />
          Open in a new tab
        </Button>
      </Centered>
    );
  else body = <Source text={content.data.text} language={language} />;

  const parts = [builderNames[build.builder], ...artifact.path.split("/")];
  const control =
    "flex h-[18px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-foreground) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)";
  return (
    <section
      aria-label={artifact.path}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-[22px] shrink-0 items-center gap-1 pr-2">
        <ol
          aria-label="Path"
          className="flex h-full min-w-0 flex-1 items-center overflow-x-auto px-3 whitespace-nowrap text-(--wb-muted) [scrollbar-width:none]"
        >
          {parts.map((part, index) => {
            const last = index === parts.length - 1;
            return (
              <li key={index} className="flex items-center">
                {index > 0 && (
                  <ChevronRight aria-hidden="true" className="mx-0.5 size-4" />
                )}
                {index === 0 && <BuilderIcon builder={build.builder} />}
                {last && <TypeIcon name={fileIconName(part)} />}
                <span
                  className={cn(
                    (index === 0 || last) && "ml-1",
                    last && "text-(--wb-foreground)",
                  )}
                >
                  {part}
                </span>
              </li>
            );
          })}
        </ol>
        {rendering !== undefined && text !== null && (
          <button
            type="button"
            aria-pressed={showRendered}
            title={
              showRendered
                ? `${rendering.title} Show the file as written.`
                : "Shown as written."
            }
            onClick={() => setAsWritten(showRendered)}
            className={cn(
              control,
              showRendered && "bg-(--wb-selected) text-(--wb-foreground)",
            )}
          >
            <rendering.icon aria-hidden="true" className="size-3.5" />
            {rendering.label}
          </button>
        )}
        <button
          type="button"
          title="Open in a new tab"
          aria-label={`Open ${artifact.path} in a new tab`}
          onClick={() => onOpenRaw(artifact.id)}
          className={control}
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {body}
    </section>
  );
}
