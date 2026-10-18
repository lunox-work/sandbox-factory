/**
 * Checks an icon body fetched from Iconify before the icon scripts write it
 * into `src/assets/`, where it ships with the web app. A body is SVG markup
 * from the network, so only shapes, paint and in-document references pass:
 * no scripts, event handlers, foreign content or links out of the file.
 */

const ELEMENTS = new Set([
  "circle",
  "clipPath",
  "defs",
  "ellipse",
  "feGaussianBlur",
  "filter",
  "g",
  "line",
  "linearGradient",
  "mask",
  "path",
  "polygon",
  "polyline",
  "radialGradient",
  "rect",
  "stop",
  "symbol",
  "use",
]);

const ATTRIBUTES = new Set([
  "clip-path",
  "clip-rule",
  "clipPathUnits",
  "color-interpolation-filters",
  "cx",
  "cy",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "fx",
  "fy",
  "gradientTransform",
  "gradientUnits",
  "height",
  "href",
  "id",
  "mask",
  "maskUnits",
  "offset",
  "opacity",
  "points",
  "r",
  "rx",
  "ry",
  "spreadMethod",
  "stdDeviation",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "transform",
  "viewBox",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "y",
  "y1",
  "y2",
]);

const TAG = /<(\/?)([A-Za-z][\w:-]*)([^<>]*)>/g;
const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Why `value` may not stand as `name`'s value, or undefined if it may. */
function unsafeValue(name, value) {
  if (/[<>]|javascript:/i.test(value)) return "markup or a script URL";
  if ((name === "href" || name === "xlink:href") && !value.startsWith("#")) {
    return "a link out of the file";
  }
  for (const [, target] of value.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!target.startsWith("#")) return "a url() out of the file";
  }
  return undefined;
}

/**
 * Returns `body` unchanged when every tag and attribute in it is allowed,
 * and throws naming `id` and the first thing that is not.
 */
export function safeSvgBody(body, id) {
  const refuse = (reason) => {
    throw new Error(`${id}: icon body refused, ${reason}`);
  };
  if (/<[!?]/.test(body)) refuse("a declaration or processing instruction");
  const outside = body.replace(TAG, (_tag, closing, element, rest) => {
    if (!ELEMENTS.has(element)) refuse(`element <${element}>`);
    if (closing === "/") {
      if (rest.trim() !== "") refuse(`a closing </${element}> with content`);
      return "";
    }
    const left = rest.replace(ATTRIBUTE, (_pair, name, double, single) => {
      if (!ATTRIBUTES.has(name)) refuse(`attribute ${name} on <${element}>`);
      const reason = unsafeValue(name, double ?? single ?? "");
      if (reason !== undefined) refuse(`${reason} in ${name}`);
      return "";
    });
    if (left.replace("/", "").trim() !== "") {
      refuse(`unreadable attributes on <${element}>`);
    }
    return "";
  });
  if (/[<>]/.test(outside)) refuse("markup outside a tag");
  return body;
}

/** `value` as a finite number for a viewBox or transform, or throws. */
export function svgNumber(value, id) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${id}: icon box refused, ${String(value)} is not a number`,
    );
  }
  return value;
}
