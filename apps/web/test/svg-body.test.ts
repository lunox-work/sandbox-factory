/**
 * The guard `scripts/file-icons.mjs` and `scripts/stack-icons.mjs` put
 * between an Iconify body and the file they write, and the icons already
 * written: every committed one must still pass it.
 */
import { describe, expect, it } from "vitest";
import { safeSvgBody, svgNumber } from "../scripts/svg-body.mjs";

const ICONS = import.meta.glob<string>("../src/assets/{files,stack}/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("safeSvgBody", () => {
  it("passes shapes, gradients and in-document references", () => {
    const body =
      '<defs><linearGradient id="a" x1="0" y1="0"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
      '<path fill="url(#a)" d="M0 0h16v16H0z"/><use href="#a"/>';
    expect(safeSvgBody(body, "test:icon")).toBe(body);
  });

  it.each([
    ["a script", "<script>alert(1)</script>"],
    ["an event handler", '<path onload="alert(1)" d="M0 0"/>'],
    ["foreign content", "<foreignObject><div/></foreignObject>"],
    ["a link out of the file", '<use href="https://example.com/x.svg#a"/>'],
    ["a script URL", '<use href="#a" fill="javascript:alert(1)"/>'],
    ["a url() out of the file", '<path fill="url(https://example.com/a)"/>'],
    ["a declaration", '<!ENTITY x "y"><path d="M0 0"/>'],
    ["an unquoted attribute", "<path d=M0/>"],
    ["markup outside a tag", '<path d="M0 0"/><'],
  ])("refuses %s", (_name, body) => {
    expect(() => safeSvgBody(body, "test:icon")).toThrow(/test:icon/);
  });

  it("passes every committed icon", () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(100);
    for (const [name, svg] of Object.entries(ICONS)) {
      const inner = /^<svg [^>]*>([\s\S]*)<\/svg>\s*$/.exec(svg)?.[1];
      expect(inner, name).toBeDefined();
      expect(() => safeSvgBody(inner ?? "", name)).not.toThrow();
    }
  });
});

describe("svgNumber", () => {
  it("passes a finite number and refuses anything else", () => {
    expect(svgNumber(16, "test:icon")).toBe(16);
    expect(() => svgNumber('16" onload="x', "test:icon")).toThrow();
    expect(() => svgNumber(Number.NaN, "test:icon")).toThrow();
  });
});
