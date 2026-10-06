/**
 * Drawing what a diagram's text describes, as SVG: Mermaid's in the page,
 * which it needs to measure its labels, and Graphviz's in a worker, where
 * laying out a graph of a few thousand edges cannot hold the page still.
 *
 * Each is loaded on first use, as few files carry a diagram, and each is a
 * megabyte or more.
 */

export type DiagramKind = "mermaid" | "dot";

/** The kind a fence's language or a file's extension names, if any. */
export function diagramKind(name: string): DiagramKind | undefined {
  const lower = name.toLowerCase();
  if (lower === "mermaid" || lower === "mmd") return "mermaid";
  if (lower === "dot" || lower === "gv" || lower === "graphviz") return "dot";
  return undefined;
}

type Mermaid = (typeof import("mermaid"))["default"];

let mermaid: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import("mermaid").then(
    ({ default: loaded }) => {
      loaded.initialize({
        startOnLoad: false,
        // Labels are the repository's text: never HTML, never a script.
        securityLevel: "strict",
        theme: "dark",
        darkMode: true,
        // The workbench's colors, not Mermaid's: its dark boxes are the
        // editor's own grey, and a table reads as a hole in the page.
        themeVariables: {
          background: "#1f1f1f",
          mainBkg: "#37373d",
          rowOdd: "#2a2d2e",
          rowEven: "#252728",
          nodeBorder: "#6e7681",
          primaryBorderColor: "#6e7681",
          primaryTextColor: "#cccccc",
          // Borders are a flat line, not a gradient from white.
          useGradient: false,
        },
        // A diagram that fails throws, rather than drawing Mermaid's own
        // error picture into the page.
        suppressErrorRendering: true,
      });
      return loaded;
    },
    (error: unknown) => {
      // A chunk that failed to load is asked for again next time.
      mermaid = undefined;
      throw error;
    },
  );
  return mermaid;
}

let drawn = 0;

async function renderMermaid(source: string): Promise<string> {
  const loaded = await loadMermaid();
  drawn += 1;
  // Unique in the page: Mermaid scopes each diagram's styles to its id.
  const { svg } = await loaded.render(`mermaid-diagram-${drawn}`, source);
  return svg;
}

interface Pending {
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
}

/** What the worker answers: the drawing, or why there is none. */
export type DotReply =
  { id: number; svg: string } | { id: number; error: string };

let worker: Worker | undefined;
const waiting = new Map<number, Pending>();
let asked = 0;

function dotWorker(): Worker {
  if (worker !== undefined) return worker;
  const started = new Worker(new URL("./dot.worker.ts", import.meta.url), {
    type: "module",
  });
  started.onmessage = (event: MessageEvent<DotReply>) => {
    const reply = event.data;
    const pending = waiting.get(reply.id);
    if (pending === undefined) return;
    waiting.delete(reply.id);
    if ("svg" in reply) pending.resolve(reply.svg);
    else pending.reject(new Error(reply.error));
  };
  started.onerror = () => {
    // The worker could not start or died: everything it held fails, and
    // the next drawing starts another.
    for (const pending of waiting.values())
      pending.reject(new Error("Graphviz could not be loaded."));
    waiting.clear();
    started.terminate();
    worker = undefined;
  };
  worker = started;
  return started;
}

function renderDot(source: string): Promise<string> {
  const target = dotWorker();
  asked += 1;
  const id = asked;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    target.postMessage({ id, source });
  });
}

/** A diagram drawn as SVG markup, as its tool wrote it. */
export function renderDiagram(
  kind: DiagramKind,
  source: string,
): Promise<string> {
  return kind === "mermaid" ? renderMermaid(source) : renderDot(source);
}

/** An SVG made safe to put in the page, and the size it was drawn at. */
export interface PreparedSvg {
  markup: string;
  width: number;
  height: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/** Where a darkened drawing's lightness runs: the editor's grey to its text. */
const DARK_FLOOR = 0.16;
const DARK_CEILING = 0.85;

let colorReader: CanvasRenderingContext2D | null | undefined;

/** A color as red, green and blue from 0 to 1; undefined when not one. */
function readColor(value: string): [number, number, number] | undefined {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  let digits = hex?.[1];
  if (digits === undefined) {
    if (!/^[a-z]+$/i.test(value) || value === "none") return undefined;
    // A name, such as Graphviz's `black` or `grey`: the canvas knows them.
    colorReader ??= document.createElement("canvas").getContext("2d");
    if (colorReader === null) return undefined;
    colorReader.fillStyle = "#010203";
    colorReader.fillStyle = value;
    const named = colorReader.fillStyle;
    if (named === "#010203" || !named.startsWith("#")) return undefined;
    digits = named.slice(1);
  }
  if (digits.length === 3)
    digits = [...digits].map((digit) => digit + digit).join("");
  return [0, 2, 4].map(
    (at) => parseInt(digits.slice(at, at + 2), 16) / 255,
  ) as [number, number, number];
}

/**
 * A color for a dark canvas: as light as it was dark, the same hue, and
 * no more vivid than it was, so a pale fill becomes a muted dark one and
 * black text becomes the editor's.
 */
function darkened([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  if (chroma > 0)
    hue =
      max === r
        ? ((g - b) / chroma + 6) % 6
        : max === g
          ? (b - r) / chroma + 2
          : (r - g) / chroma + 4;
  const flipped = DARK_FLOOR + (1 - lightness) * (DARK_CEILING - DARK_FLOOR);
  const kept = Math.min(chroma, 1 - Math.abs(2 * flipped - 1));
  const x = kept * (1 - Math.abs((hue % 2) - 1));
  const [r1, g1, b1] =
    hue < 1
      ? [kept, x, 0]
      : hue < 2
        ? [x, kept, 0]
        : hue < 3
          ? [0, kept, x]
          : hue < 4
            ? [0, x, kept]
            : hue < 5
              ? [x, 0, kept]
              : [kept, 0, x];
  const m = flipped - kept / 2;
  return `#${[r1, g1, b1]
    .map((channel) =>
      Math.round((channel + m) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Graphviz's drawing, made for white paper, put on the editor's dark
 * canvas: its page is taken away and every color turned, so it reads as
 * Mermaid's dark diagrams do. A graph that chose a dark page is left as
 * it is.
 */
function darkenGraphviz(svg: SVGSVGElement) {
  const page = svg.querySelector(":scope > g.graph > polygon");
  const paper = readColor(page?.getAttribute("fill") ?? "white");
  if (paper !== undefined && Math.max(...paper) + Math.min(...paper) < 1)
    return;
  page?.setAttribute("fill", "none");
  const turned = new Map<string, string | undefined>();
  for (const element of svg.querySelectorAll("[fill], [stroke]")) {
    if (element === page) continue;
    for (const name of ["fill", "stroke"]) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      if (!turned.has(value)) {
        const color = readColor(value);
        turned.set(value, color && darkened(color));
      }
      const color = turned.get(value);
      if (color !== undefined) element.setAttribute(name, color);
    }
  }
  // Text without a color of its own is black, and inherits this instead.
  svg.setAttribute("fill", darkened([0, 0, 0]));
}

/**
 * The SVG with nothing in it that runs, and with links only to the web,
 * opening in a new tab: Graphviz writes a node's `URL` as a link, and a
 * repository's analysis may give it any. Sized in pixels from its view
 * box, so it can be scaled; undefined when it is not an SVG. A Graphviz
 * drawing, with `darken`, is turned for the dark canvas.
 */
export function prepareSvg(
  text: string,
  { darken = false }: { darken?: boolean } = {},
): PreparedSvg | undefined {
  // Read as a web page reads SVG inline, not as XML: Mermaid's labels are
  // HTML, with a `<br>` that no XML parser accepts. A parsed document runs
  // nothing.
  const parsed = new DOMParser().parseFromString(text, "text/html");
  const svg = [...parsed.body.children].find(
    (child) => child.namespaceURI === SVG_NS && child.localName === "svg",
  );
  if (!(svg instanceof SVGSVGElement)) return undefined;
  for (const script of [...svg.getElementsByTagName("script")]) script.remove();
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      // An HTML label's `xmlns` is read as a plain attribute; the
      // serializer writes the namespace itself, and twice is not XML.
      const declaration =
        attribute.namespaceURI === null && /^xmlns(:|$)/.test(name);
      if (name.startsWith("on") || declaration)
        element.removeAttributeNode(attribute);
    }
    if (element.localName === "a") {
      const href =
        element.getAttribute("href") ??
        element.getAttributeNS(XLINK_NS, "href") ??
        "";
      element.removeAttribute("href");
      element.removeAttributeNS(XLINK_NS, "href");
      if (/^https?:\/\//i.test(href)) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
    } else if (element.localName !== "image") {
      // `<use>` and the animations may point anywhere; a picture points
      // nowhere it does not draw.
      for (const name of ["href", "xlink:href"])
        if (/^\s*javascript:/i.test(element.getAttribute(name) ?? ""))
          element.removeAttribute(name);
    }
  }
  const box = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  const fromBox = box.length === 4 && box.every(Number.isFinite);
  const width = fromBox ? box[2] : parseFloat(svg.getAttribute("width") ?? "");
  const height = fromBox
    ? box[3]
    : parseFloat(svg.getAttribute("height") ?? "");
  if (
    width === undefined ||
    height === undefined ||
    !(width > 0) ||
    !(height > 0)
  )
    return undefined;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  // Mermaid caps its width in a style; the canvas decides the size here.
  svg.style.removeProperty("max-width");
  if (darken) darkenGraphviz(svg);
  return {
    markup: new XMLSerializer().serializeToString(svg),
    width,
    height,
  };
}
