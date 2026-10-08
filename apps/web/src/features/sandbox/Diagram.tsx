/**
 * Diagrams in the workbench: a canvas to pan and zoom a drawing larger
 * than its pane, a diagram file filling the editor, and a diagram fence
 * drawn in its document, where it can be opened full size or read as
 * written.
 */

import { Code, Maximize2, Scan, ZoomIn, ZoomOut, Workflow } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ErrorBanner, LoadingLine } from "@/components/Message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import {
  prepareSvg,
  renderDiagram,
  type DiagramKind,
  type PreparedSvg,
} from "./diagrams";
import { Centered } from "./workbench";

export type Drawing =
  | { state: "drawing" }
  | { state: "drawn"; svg: PreparedSvg }
  | { state: "failed"; reason: string };

/** A diagram's text, drawn; drawn again when the text changes. */
function useDiagram(kind: DiagramKind, source: string): Drawing {
  const [result, setResult] = useState<{
    kind: DiagramKind;
    source: string;
    drawing: Drawing;
  } | null>(null);
  useEffect(() => {
    let live = true;
    renderDiagram(kind, source).then(
      (svg) => {
        const prepared = prepareSvg(svg, { skin: kind === "dot" });
        if (live)
          setResult({
            kind,
            source,
            drawing:
              prepared === undefined
                ? { state: "failed", reason: "The drawing was not an SVG." }
                : { state: "drawn", svg: prepared },
          });
      },
      (error: unknown) => {
        if (live)
          setResult({
            kind,
            source,
            drawing: {
              state: "failed",
              reason:
                error instanceof Error && error.message !== ""
                  ? error.message
                  : "The diagram could not be drawn.",
            },
          });
      },
    );
    return () => {
      live = false;
    };
  }, [kind, source]);
  return result !== null && result.kind === kind && result.source === source
    ? result.drawing
    : { state: "drawing" };
}

interface View {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** Space kept around a drawing fitted to its pane, in pixels. */
const MARGIN = 24;
/** How far a pointer moves before a press is a drag, not a click. */
const DRAG_SLOP = 3;

const clampScale = (scale: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/**
 * A drawing of a known size in a pane it may not fit: fitted to begin
 * with, then dragged to pan and scrolled or pinched to zoom about the
 * pointer, as a map is. The keyboard does the same with the arrows, `+`,
 * `-` and `0`.
 */
function ZoomCanvas({
  width,
  height,
  label,
  children,
}: {
  /** The drawing's own size, in pixels. */
  width: number;
  height: number;
  /** What the drawing is, for assistive technology. */
  label: string;
  children: React.ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  /**
   * The whole drawing in the pane, centred; or, opening one far longer
   * than the pane in one direction, fitted across it and started at its
   * beginning, where fitting all of it would leave nothing legible.
   */
  const frame = useCallback(
    (whole: boolean) => {
      const element = viewport.current;
      if (element === null) return;
      const { clientWidth, clientHeight } = element;
      if (clientWidth === 0 || clientHeight === 0) return;
      // Never past its own size: a small diagram is not blown up.
      const across = Math.min((clientWidth - MARGIN * 2) / width, 1);
      const down = Math.min((clientHeight - MARGIN * 2) / height, 1);
      const all = clampScale(Math.min(across, down));
      const centred = (scale: number) => ({
        scale,
        x: (clientWidth - width * scale) / 2,
        y: (clientHeight - height * scale) / 2,
      });
      if (whole) setView(centred(all));
      else if (across > down * 2)
        setView({ ...centred(clampScale(across)), y: MARGIN });
      else if (down > across * 2)
        setView({ ...centred(clampScale(down)), x: MARGIN });
      else setView(centred(all));
    },
    [width, height],
  );
  const fit = useCallback(() => frame(true), [frame]);
  useLayoutEffect(() => frame(false), [frame]);

  /** Zoomed by a factor about a point in the pane, which stays put. */
  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const element = viewport.current;
    const current = viewRef.current;
    const x = px ?? (element?.clientWidth ?? 0) / 2;
    const y = py ?? (element?.clientHeight ?? 0) / 2;
    const scale = clampScale(current.scale * factor);
    const ratio = scale / current.scale;
    setView({
      scale,
      x: x - (x - current.x) * ratio,
      y: y - (y - current.y) * ratio,
    });
  }, []);

  // Not React's wheel handler: it is passive, and this one must stop the
  // page scrolling while it zooms.
  useEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const box = element.getBoundingClientRect();
      // A pinch arrives as a Ctrl-scroll of small steps; a wheel's notch
      // is a hundred pixels or so, and zooms by about a fifth.
      const rate = event.ctrlKey ? 0.01 : 0.002;
      zoomAt(
        Math.exp(-event.deltaY * unit * rate),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const drag = useRef<{
    pointer: number;
    startX: number;
    startY: number;
    from: View;
    moving: boolean;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    drag.current = {
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: viewRef.current,
      moving: false,
    };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    if (current === null || current.pointer !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moving) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      // Captured only once it is a drag, so a click still reaches a link.
      current.moving = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }
    setView({
      ...current.from,
      x: current.from.x + dx,
      y: current.from.y + dy,
    });
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = 48;
    const current = viewRef.current;
    const moves: Record<string, () => void> = {
      "+": () => zoomAt(1.25),
      "=": () => zoomAt(1.25),
      "-": () => zoomAt(0.8),
      "0": fit,
      ArrowLeft: () => setView({ ...current, x: current.x + step }),
      ArrowRight: () => setView({ ...current, x: current.x - step }),
      ArrowUp: () => setView({ ...current, y: current.y + step }),
      ArrowDown: () => setView({ ...current, y: current.y - step }),
    };
    const move = moves[event.key];
    if (move === undefined || event.altKey || event.ctrlKey || event.metaKey)
      return;
    event.preventDefault();
    move();
  };

  const control =
    "flex h-6 min-w-6 items-center justify-center rounded-[4px] px-1 text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-foreground) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)";
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div
        ref={viewport}
        role="group"
        aria-roledescription="diagram"
        aria-label={label}
        tabIndex={0}
        data-testid="diagram-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          "relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden select-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width,
            height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          {children}
        </div>
      </div>
      <div
        role="toolbar"
        aria-label="Zoom"
        className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-[4px] border border-(--wb-border) bg-(--wb-chrome) p-0.5 text-xs shadow-lg shadow-black/40"
      >
        <button
          type="button"
          title="Zoom out (-)"
          aria-label="Zoom out"
          className={control}
          onClick={() => zoomAt(0.8)}
        >
          <ZoomOut aria-hidden="true" className="size-3.5" />
        </button>
        {/* Not a live region: a wheel's every tick would be announced. */}
        <span className="w-11 text-center text-(--wb-muted) tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          title="Zoom in (+)"
          aria-label="Zoom in"
          className={control}
          onClick={() => zoomAt(1.25)}
        >
          <ZoomIn aria-hidden="true" className="size-3.5" />
        </button>
        <button
          type="button"
          title="Fit to view (0)"
          aria-label="Fit to view"
          className={control}
          onClick={fit}
        >
          <Scan aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Drawn SVG markup, made safe by `prepareSvg`, at its own size. */
function Svg({ svg, className }: { svg: PreparedSvg; className?: string }) {
  return (
    <div
      className={cn("[&>svg]:block", className)}
      // Scripts, handlers and links off the web were taken out first.
      dangerouslySetInnerHTML={{ __html: svg.markup }}
    />
  );
}

/** Why a diagram was not drawn: the tool's words, which name the line. */
function Reason({ children }: { children: string }) {
  return (
    <pre className="max-h-40 max-w-xl overflow-auto text-left font-(family-name:--wb-font-code) text-xs whitespace-pre-wrap text-(--wb-muted)">
      {children}
    </pre>
  );
}

/** A diagram file, drawn to fill the editor. */
export function DiagramView({
  kind,
  source,
  label,
}: {
  kind: DiagramKind;
  source: string;
  label: string;
}) {
  const drawing = useDiagram(kind, source);
  if (drawing.state === "drawing")
    return (
      <Centered>
        <LoadingLine>Drawing the diagram…</LoadingLine>
      </Centered>
    );
  if (drawing.state === "failed")
    return (
      <Centered>
        <ErrorBanner className="mt-0">
          This diagram could not be drawn.
        </ErrorBanner>
        <Reason>{drawing.reason}</Reason>
      </Centered>
    );
  return (
    <ZoomCanvas
      width={drawing.svg.width}
      height={drawing.svg.height}
      label={label}
    >
      <Svg svg={drawing.svg} />
    </ZoomCanvas>
  );
}

/** An SVG file, shown as a picture: as an image, nothing in it runs. */
export function SvgPicture({ text, label }: { text: string; label: string }) {
  const svg = prepareSvg(text);
  if (svg === undefined)
    return (
      <Centered>This file is not an SVG drawing that can be shown.</Centered>
    );
  return (
    <ZoomCanvas width={svg.width} height={svg.height} label={label}>
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.markup)}`}
        alt={label}
        width={svg.width}
        height={svg.height}
        draggable={false}
        className="block max-w-none"
      />
    </ZoomCanvas>
  );
}

/**
 * A diagram fence in a document, drawn where it stands and no wider than
 * the column; opened full size to pan and zoom, or read as written. One
 * that cannot be drawn reads as written, with why.
 */
export function DiagramFigure({
  kind,
  source,
  asWritten: written,
}: {
  kind: DiagramKind;
  source: string;
  /** The fence as written, as the document draws a code block. */
  asWritten: React.ReactNode;
}) {
  const drawing = useDiagram(kind, source);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const name = kind === "mermaid" ? "Mermaid diagram" : "Graphviz diagram";

  if (drawing.state === "failed")
    return (
      <div>
        {written}
        <p className="-mt-2 mb-4 text-xs text-(--wb-muted)">
          Not drawn: {drawing.reason.split("\n")[0]}
        </p>
      </div>
    );
  const control =
    "flex h-6 items-center gap-1 rounded-[4px] px-1.5 text-xs text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-foreground) focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--wb-accent)";
  return (
    <figure
      aria-label={name}
      className="group relative my-4 rounded-[3px] bg-(--wb-chrome)"
    >
      {drawing.state === "drawn" && (
        <div className="absolute top-1.5 right-1.5 z-10 flex gap-0.5 rounded-[4px] bg-(--wb-chrome) opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            aria-pressed={showSource}
            title={showSource ? "Show the diagram" : "Show the source"}
            className={control}
            onClick={() => setShowSource(!showSource)}
          >
            {showSource ? (
              <Workflow aria-hidden="true" className="size-3.5" />
            ) : (
              <Code aria-hidden="true" className="size-3.5" />
            )}
            {showSource ? "Diagram" : "Source"}
          </button>
          <button
            type="button"
            title="Open full size to pan and zoom"
            aria-label={`Open the ${name} full size`}
            className={control}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
      {drawing.state === "drawing" ? (
        <div className="flex h-24 items-center justify-center text-xs text-(--wb-muted)">
          Drawing the diagram…
        </div>
      ) : showSource ? (
        <div className="[&>pre]:my-0">{written}</div>
      ) : (
        /*
          A click anywhere opens it full size, a mouse's shortcut; the
          toolbar's button is the way for everyone else. Not a button
          itself: a Graphviz drawing has links in it, and links inside a
          button are not reachable as links.
        */
        <div
          title="Open full size"
          onClick={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("a") !== null
            )
              return;
            setExpanded(true);
          }}
          className="block w-full cursor-zoom-in overflow-hidden px-4 py-3 text-left"
        >
          <Svg
            svg={drawing.svg}
            className="mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
          />
        </div>
      )}
      {drawing.state === "drawn" && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent
            overlayClassName="bg-black/40 backdrop-blur-none"
            className="workbench dark flex h-[min(90dvh,60rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-clip rounded-lg border-(--wb-border) bg-(--wb-editor) p-0 shadow-2xl ring-1 shadow-black/60 ring-white/5 sm:max-w-[min(96vw,110rem)] sm:p-0"
          >
            <header className="flex h-[35px] shrink-0 items-center border-b border-(--wb-border) bg-(--wb-chrome) pr-10 pl-3">
              <DialogTitle className="truncate text-xs font-normal text-(--wb-foreground)">
                {name}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Drag to pan; scroll or pinch to zoom.
              </DialogDescription>
            </header>
            <ZoomCanvas
              width={drawing.svg.width}
              height={drawing.svg.height}
              label={name}
            >
              <Svg svg={drawing.svg} />
            </ZoomCanvas>
          </DialogContent>
        </Dialog>
      )}
    </figure>
  );
}
