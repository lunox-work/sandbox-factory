/**
 * Drawing what a diagram's text describes, as SVG: Mermaid's in the page,
 * which it needs to measure its labels, and Graphviz's in a worker, where
 * laying out a graph of a few thousand edges cannot hold the page still.
 *
 * Each is loaded on first use, as few files carry a diagram, and each is a
 * megabyte or more.
 */

import { DIAGRAM_LAYOUT_FONTS, DIAGRAM_SKIN } from "@sandbox-factory/shared";

export type DiagramKind = "mermaid" | "dot";

/**
 * The skin's faces, which `index.css` declares: Geist for names, Geist
 * Mono for anything technical, each falling back to the system's.
 */
const SANS = `"Geist Variable", Geist, ui-sans-serif, system-ui, sans-serif`;
const MONO = `"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace`;

const skin = DIAGRAM_SKIN.dark;

/**
 * The faces, loaded before Mermaid measures its labels: measured in the
 * fallback, a label overflows its box once Geist arrives. A font that
 * cannot load leaves the fallback, which the boxes are then measured in.
 */
async function skinFontsLoaded(): Promise<void> {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  await Promise.all(
    [
      `400 12px "Geist Variable"`,
      `600 12px "Geist Variable"`,
      `400 12px "Geist Mono Variable"`,
    ].map((font) => document.fonts.load(font).catch(() => [])),
  );
}

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
        // The diagram skin's dark roles, not Mermaid's palette: boxes a step
        // above the editor's grey with an ink hairline, muted connectors,
        // containers below the page, no gradient and no shadow.
        theme: "base",
        look: "classic",
        darkMode: true,
        fontFamily: SANS,
        themeVariables: {
          darkMode: true,
          fontFamily: SANS,
          fontSize: "12px",
          background: skin.paper,
          primaryColor: skin.node,
          primaryBorderColor: skin.ink,
          primaryTextColor: skin.ink,
          secondaryColor: skin.paper2,
          secondaryBorderColor: skin.rule,
          secondaryTextColor: skin.ink,
          tertiaryColor: skin.paper2,
          tertiaryBorderColor: skin.rule,
          tertiaryTextColor: skin.ink,
          mainBkg: skin.node,
          nodeBorder: skin.ink,
          nodeTextColor: skin.ink,
          textColor: skin.ink,
          titleColor: skin.ink,
          lineColor: skin.muted,
          // An edge label's mask: the page, so the line stops short of it.
          edgeLabelBackground: skin.paper,
          clusterBkg: skin.paper2,
          clusterBorder: skin.rule,
          noteBkgColor: skin.paper2,
          noteBorderColor: skin.rule,
          noteTextColor: skin.muted,
          // An entity's rows.
          rowOdd: skin.node,
          rowEven: skin.paper,
          attributeBackgroundColorOdd: skin.node,
          attributeBackgroundColorEven: skin.paper,
          // A sequence's actors and messages.
          actorBkg: skin.node,
          actorBorder: skin.ink,
          actorTextColor: skin.ink,
          actorLineColor: skin.rule,
          signalColor: skin.muted,
          signalTextColor: skin.ink,
          labelBoxBkgColor: skin.node,
          labelBoxBorderColor: skin.rule,
          labelTextColor: skin.ink,
          loopTextColor: skin.muted,
          activationBkgColor: skin.paper2,
          activationBorderColor: skin.rule,
          // A state machine's start and end.
          specialStateColor: skin.muted,
          useGradient: false,
          dropShadow: "none",
        },
        // What no variable reaches: a box's corners, at the skin's radius,
        // and the hollow circle of an entity relation's "zero", which
        // Mermaid fills white whatever the theme.
        themeCSS: `
          .node rect.label-container { rx: 6px; ry: 6px; }
          .marker.er circle { fill: ${skin.paper}; }
        `,
        // Right-angled connectors with rounded elbows, as the skin draws
        // them. The flowchart's curve is the default for every diagram
        // Mermaid lays out the same way, entity relations among them.
        flowchart: { curve: "rounded" },
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
  const [loaded] = await Promise.all([loadMermaid(), skinFontsLoaded()]);
  drawn += 1;
  // Unique in the page: Mermaid scopes each diagram's styles to its id.
  const { svg } = await loaded.render(`mermaid-diagram-${drawn}`, source);
  return svg;
}

interface Pending {
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
}

type DotAttributes = Record<string, string | number>;

/**
 * What the worker is asked: a graph, and the attributes it starts from,
 * which anything the graph sets for itself overrides.
 */
export interface DotRequest {
  id: number;
  source: string;
  defaults: {
    graph: DotAttributes;
    node: DotAttributes;
    edge: DotAttributes;
  };
}

/** What the worker answers: the drawing, or why there is none. */
export type DotReply =
  { id: number; svg: string } | { id: number; error: string };

/**
 * A graph that says nothing of its looks is drawn in the skin: rounded
 * boxes with an ink hairline on a node fill, muted connectors with a small
 * head, in the fonts Graphviz can measure that the page then draws as
 * Geist. In the light roles, as a `.dot` file written in the skin carries
 * them, and turned for the editor with the rest.
 */
const light = DIAGRAM_SKIN.light;
export const DOT_DEFAULTS: DotRequest["defaults"] = {
  graph: {
    fontname: DIAGRAM_LAYOUT_FONTS.sans,
    fontcolor: light.ink,
    color: light.rule,
    style: "rounded",
  },
  node: {
    shape: "box",
    style: "rounded,filled",
    color: light.ink,
    fillcolor: light.node,
    fontcolor: light.ink,
    fontname: DIAGRAM_LAYOUT_FONTS.sans,
    // Drawn a tenth smaller, at the skin's 12px, once it is Geist.
    fontsize: 13,
    margin: "0.16,0.08",
    penwidth: 1,
  },
  edge: {
    color: light.muted,
    fontcolor: light.muted,
    fontname: DIAGRAM_LAYOUT_FONTS.mono,
    fontsize: 9,
    arrowsize: 0.6,
    penwidth: 1,
  },
};

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

/**
 * The largest DOT source drawn here. A whole repository's dependency graph
 * can be megabytes, and its layout runs for minutes; past this it is read as
 * text instead.
 */
export const DOT_SOURCE_MAX = 512 * 1024;
/** How long one layout may take before the worker is stopped. */
export const DOT_TIMEOUT_MS = 30_000;

function renderDot(source: string): Promise<string> {
  if (source.length > DOT_SOURCE_MAX)
    return Promise.reject(
      new Error("This graph is too large to draw here. Read it as source."),
    );
  const target = dotWorker();
  asked += 1;
  const id = asked;
  return new Promise((resolve, reject) => {
    // A layout that does not finish holds the one worker, and every
    // drawing queued behind it. Stopped, it fails with them, and the next
    // drawing starts a fresh worker.
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      for (const pending of waiting.values())
        pending.reject(
          new Error("The graph took too long to draw. Read it as source."),
        );
      waiting.clear();
      target.terminate();
      if (worker === target) worker = undefined;
    }, DOT_TIMEOUT_MS);
    waiting.set(id, {
      resolve: (svg) => {
        clearTimeout(timer);
        resolve(svg);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    target.postMessage({
      id,
      source,
      defaults: DOT_DEFAULTS,
    } satisfies DotRequest);
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
 * Each light role's dark counterpart. Graphviz writes a color's opacity as
 * an attribute of its own, so a role at an opacity keeps it: ink at a
 * tenth on white paper is ink at a tenth on the editor.
 */
const SKIN_TURNED = new Map<string, string>(
  Object.entries(DIAGRAM_SKIN.light).map(([role, color]) => [
    color,
    DIAGRAM_SKIN.dark[role as keyof typeof DIAGRAM_SKIN.dark],
  ]),
);

/** The faces Graphviz measured with, and the skin's that draw in their place. */
const SANS_LAYOUT = /^\s*["']?(helvetica|arial)\b/i;
const MONO_LAYOUT = /^\s*["']?courier\b/i;
/**
 * Geist runs wider than the Helvetica a label was measured in, about a
 * twentieth at its regular weight and a tenth at a name's, so it is drawn
 * that much smaller to stay in its box. Geist Mono and Courier match.
 */
const SANS_FIT = 0.95;
const NAME_FIT = 0.9;

/**
 * Graphviz's drawing in the diagram skin, on the editor's dark canvas.
 *
 * Text it measured as Helvetica or Arial is drawn in Geist, a node's name
 * at the weight a name takes, and Courier in Geist Mono; the widths are
 * close enough that a label still fits its box. A dash is the skin's, long
 * enough to read as one.
 *
 * Made for white paper, as Graphviz draws by default, its page is taken
 * away and every color turned: the skin's own roles to their dark
 * counterparts, anything else by lightness, keeping its hue. A graph that
 * chose a dark page keeps its colors.
 */
function skinGraphviz(svg: SVGSVGElement) {
  for (const text of svg.querySelectorAll("text[font-family]")) {
    const family = text.getAttribute("font-family") ?? "";
    if (MONO_LAYOUT.test(family)) text.setAttribute("font-family", MONO);
    else if (SANS_LAYOUT.test(family)) {
      text.setAttribute("font-family", SANS);
      const name =
        text.closest("g.node") !== null && !text.hasAttribute("font-weight");
      if (name) text.setAttribute("font-weight", "600");
      const size = parseFloat(text.getAttribute("font-size") ?? "");
      if (size > 0)
        text.setAttribute(
          "font-size",
          (size * (name ? NAME_FIT : SANS_FIT)).toFixed(2),
        );
    }
  }
  for (const element of svg.querySelectorAll('[stroke-dasharray="5,2"]'))
    element.setAttribute("stroke-dasharray", "5,4");

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
        const role = SKIN_TURNED.get(value.toLowerCase());
        const color = role === undefined ? readColor(value) : undefined;
        turned.set(value, role ?? (color && darkened(color)));
      }
      const color = turned.get(value);
      if (color !== undefined) element.setAttribute(name, color);
    }
  }
  // Text without a color of its own is black, and inherits ink instead.
  svg.setAttribute("fill", skin.ink);
}

/** Elements a drawing never needs and that could run or reach out. */
const UNSAFE_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "base",
  "link",
  "meta",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "audio",
  "video",
  "source",
  "track",
  "portal",
  "set",
  "animate",
  "animatemotion",
  "animatetransform",
  "discard",
  "handler",
  "listener",
]);
/** Attributes whose value is fetched, followed or run. */
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "data",
  "poster",
  "background",
  "ping",
  "lowsrc",
  "dynsrc",
  "codebase",
]);
/**
 * CSS with nothing fetched: `@import` and any `url()` that is not a
 * reference within the drawing (a marker or gradient by `#id`) are taken
 * out, as is the `expression()` old engines ran.
 */
function safeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "(");
}

/**
 * The SVG with nothing in it that runs, and with links only to the web,
 * opening in a new tab: Graphviz writes a node's `URL` as a link, and a
 * repository's analysis may give it any. Sized in pixels from its view
 * box, so it can be scaled; undefined when it is not an SVG. A Graphviz
 * drawing, with `skin`, is drawn in the diagram skin on the dark canvas.
 */
export function prepareSvg(
  text: string,
  { skin: skinned = false }: { skin?: boolean } = {},
): PreparedSvg | undefined {
  // Read as a web page reads SVG inline, not as XML: Mermaid's labels are
  // HTML, with a `<br>` that no XML parser accepts. A parsed document runs
  // nothing.
  const parsed = new DOMParser().parseFromString(text, "text/html");
  const svg = [...parsed.body.children].find(
    (child) => child.namespaceURI === SVG_NS && child.localName === "svg",
  );
  if (!(svg instanceof SVGSVGElement)) return undefined;
  // What runs, embeds another document, submits or rewrites an attribute
  // goes, wherever it is, Mermaid's HTML labels in `<foreignObject>` too:
  // an `<iframe srcdoc>` there, or a `<set>` that turns a link's `href` to
  // `javascript:`, would run in this page. Neither Graphviz nor Mermaid
  // draws any of them.
  for (const element of [...svg.querySelectorAll("*")])
    if (UNSAFE_ELEMENTS.has(element.localName.toLowerCase())) element.remove();
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    const tag = element.localName.toLowerCase();
    for (const attribute of [...element.attributes]) {
      const name = attribute.localName.toLowerCase();
      // An HTML label's `xmlns` is read as a plain attribute; the
      // serializer writes the namespace itself, and twice is not XML.
      const declaration =
        attribute.namespaceURI === null && /^xmlns(:|$)/.test(name);
      if (name.startsWith("on") || declaration || name === "srcdoc") {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (URL_ATTRIBUTES.has(name)) {
        const value = attribute.value.trim();
        // Only what a drawing needs, each where it needs it: a link out
        // to the web, a reference within the drawing, a picture inline.
        const allowed =
          (tag === "a" &&
            name.endsWith("href") &&
            /^https?:\/\//i.test(value)) ||
          (name.endsWith("href") && tag !== "a" && value.startsWith("#")) ||
          (tag === "image" && /^data:image\/(png|gif|jpeg|webp);/i.test(value));
        if (!allowed) element.removeAttributeNode(attribute);
        continue;
      }
      if (name === "style") attribute.value = safeCss(attribute.value);
    }
    if (tag === "style")
      element.textContent = safeCss(element.textContent ?? "");
    if (tag === "a" && element.hasAttribute("href")) {
      // Re-set without the namespace, so it serializes as plain `href`.
      const href = element.getAttribute("href") ?? "";
      element.setAttribute("href", href);
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noreferrer noopener");
    } else if (tag === "a") {
      const href = element.getAttributeNS(XLINK_NS, "href");
      element.removeAttributeNS(XLINK_NS, "href");
      if (href !== null && /^https?:\/\//i.test(href.trim())) {
        element.setAttribute("href", href.trim());
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noreferrer noopener");
      }
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
  if (skinned) skinGraphviz(svg);
  return {
    markup: new XMLSerializer().serializeToString(svg),
    width,
    height,
  };
}
