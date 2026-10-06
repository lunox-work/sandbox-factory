/**
 * The pure parts of drawing what a builder wrote: which names are
 * diagrams, an SVG made safe to put in the page, and wiki links resolved
 * to the notes they name.
 */

import { expect, test } from "vitest";

import { diagramKind, prepareSvg } from "../src/features/sandbox/diagrams";
import { wikiLinkedFile } from "../src/features/sandbox/file-tree";
import { withWikiLinks } from "../src/features/sandbox/MarkdownDocument";

test("Mermaid and Graphviz are known by a fence's language or an extension", () => {
  expect(diagramKind("mermaid")).toBe("mermaid");
  expect(diagramKind("MMD")).toBe("mermaid");
  expect(diagramKind("dot")).toBe("dot");
  expect(diagramKind("gv")).toBe("dot");
  expect(diagramKind("graphviz")).toBe("dot");
  expect(diagramKind("ts")).toBeUndefined();
  expect(diagramKind("")).toBeUndefined();
});

test("an SVG is sized from its view box, with nothing in it that runs", () => {
  const prepared = prepareSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" viewBox="0 0 320 120" style="max-width: 320px;" onload="steal()">
      <script>steal()</script>
      <a xlink:href="https://www.npmjs.com/package/zod"><text onclick="steal()">zod</text></a>
      <a xlink:href="javascript:steal()"><text>bad</text></a>
      <a href="src/app.ts"><text>local</text></a>
      <use href="javascript:steal()"/>
    </svg>`,
  );
  expect(prepared).toBeDefined();
  if (prepared === undefined) return;
  expect(prepared.width).toBe(320);
  expect(prepared.height).toBe(120);
  const svg = new DOMParser().parseFromString(
    prepared.markup,
    "image/svg+xml",
  ).documentElement;
  expect(svg.getAttribute("width")).toBe("320");
  expect(svg.getAttribute("height")).toBe("120");
  expect(svg.getAttribute("style") ?? "").not.toContain("max-width");
  expect(prepared.markup).not.toContain("steal");
  const links = [...svg.getElementsByTagName("a")];
  // A link to the web opens in a new tab; any other link is taken out.
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://www.npmjs.com/package/zod",
    null,
    null,
  ]);
  expect(links[0]?.getAttribute("target")).toBe("_blank");
  expect(links[0]?.getAttribute("rel")).toBe("noreferrer noopener");
});

test("Mermaid's HTML labels, which are not XML, are read as a page reads them", () => {
  const prepared = prepareSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 20"><foreignObject width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><p>first<br>second</p></div></foreignObject></svg>`,
  );
  expect(prepared).toMatchObject({ width: 80, height: 20 });
  // Written back as XML, so it also opens as an image.
  const reread = new DOMParser().parseFromString(
    prepared?.markup ?? "",
    "image/svg+xml",
  );
  expect(reread.getElementsByTagName("parsererror")).toHaveLength(0);
  expect(reread.documentElement.textContent).toBe("firstsecond");
});

test("a Graphviz drawing on white paper is turned for the dark canvas", () => {
  const drawing = (paper: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><g id="graph0" class="graph"><polygon fill="${paper}" stroke="none" points="0,0 100,0 100,40 0,40"/><g class="cluster"><path fill="#ffffff" stroke="#000000" d="M0,0"/></g><g class="node"><path fill="#ddfeff" stroke="#000000" d="M0,0"/><text>app.ts</text></g><g class="edge"><path fill="none" stroke="#000000" stroke-opacity="0.2" d="M0,0"/></g></g></svg>`;
  const read = (markup: string | undefined) =>
    new DOMParser().parseFromString(markup ?? "", "image/svg+xml")
      .documentElement;

  const svg = read(prepareSvg(drawing("#ffffff"), { darken: true })?.markup);
  const paths = [...svg.getElementsByTagName("path")];
  // The page is gone, so the editor shows through, as behind Mermaid's.
  expect(svg.getElementsByTagName("polygon")[0]?.getAttribute("fill")).toBe(
    "none",
  );
  // White is the editor's grey, black its text: light as the other was dark.
  expect(paths[0]?.getAttribute("fill")).toBe("#292929");
  expect(paths[0]?.getAttribute("stroke")).toBe("#d9d9d9");
  // A pale fill keeps its hue, dark and muted rather than vivid.
  expect(paths[1]?.getAttribute("fill")).toBe("#244546");
  // What draws nothing, and what only fades, are left as they are.
  expect(paths[2]?.getAttribute("fill")).toBe("none");
  expect(paths[2]?.getAttribute("stroke-opacity")).toBe("0.2");
  // Text with no color of its own inherits the editor's.
  expect(svg.getAttribute("fill")).toBe("#d9d9d9");

  // A graph that chose a dark page keeps its colors, and Mermaid's are
  // never turned.
  const dark = read(prepareSvg(drawing("#101010"), { darken: true })?.markup);
  expect(dark.getElementsByTagName("path")[1]?.getAttribute("fill")).toBe(
    "#ddfeff",
  );
  const untouched = read(prepareSvg(drawing("#ffffff"))?.markup);
  expect(untouched.getElementsByTagName("path")[1]?.getAttribute("fill")).toBe(
    "#ddfeff",
  );
});

test("an SVG without a size, or what is not an SVG, is not prepared", () => {
  expect(
    prepareSvg(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
  ).toBeUndefined();
  expect(prepareSvg("<html><body>no</body></html>")).toBeUndefined();
  expect(prepareSvg("not markup")).toBeUndefined();
  expect(
    prepareSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="207pt" height="112pt"></svg>`,
    ),
  ).toMatchObject({ width: 207, height: 112 });
});

test("a wiki link opens the note of its name, nearest first", () => {
  const paths = [
    "graphify/GRAPH_REPORT.md",
    "graphify/wiki/Community_0.md",
    "graphify/wiki/index.md",
    "graphify/graph.json",
    "deepwiki/wiki/index.md",
  ];
  const report = "graphify/GRAPH_REPORT.md";
  const note = "graphify/wiki/Community_0.md";
  expect(wikiLinkedFile(paths, note, "Community 0")).toBe(note);
  // Graphify's report names a community after a prefix.
  expect(wikiLinkedFile(paths, report, "_COMMUNITY_Community 0")).toBe(note);
  // Beside the file first, then its own top folder.
  expect(wikiLinkedFile(paths, note, "index")).toBe("graphify/wiki/index.md");
  expect(wikiLinkedFile(paths, "deepwiki/a.md", "index")).toBe(
    "deepwiki/wiki/index.md",
  );
  expect(wikiLinkedFile(paths, note, "Community 0#Key Concepts")).toBe(note);
  // Only notes: a JSON file is not one.
  expect(wikiLinkedFile(paths, note, "graph")).toBeUndefined();
  expect(wikiLinkedFile(paths, note, "Community 99")).toBeUndefined();
});

test("wiki links become Markdown links, or their label, and code is left alone", () => {
  const resolve = (target: string) =>
    target === "Community 0" ? "graphify/wiki/Community_0.md" : undefined;
  expect(
    withWikiLinks(
      "See [[Community 0]], [[Community 0|the first]] and [[Gone|gone]].\n" +
        "`[[Community 0]]`\n```\n[[Community 0]]\n```",
      resolve,
    ),
  ).toBe(
    "See [Community 0](</graphify/wiki/Community_0.md>), " +
      "[the first](</graphify/wiki/Community_0.md>) and gone.\n" +
      "`[[Community 0]]`\n```\n[[Community 0]]\n```",
  );
});
