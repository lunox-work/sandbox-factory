/**
 * The pure parts of drawing what a builder wrote: which names are
 * diagrams, an SVG made safe to put in the page, and wiki links resolved
 * to the notes they name.
 */

import { expect, test } from "vitest";

import {
  diagramKind,
  DOT_SOURCE_MAX,
  prepareSvg,
  renderDiagram,
} from "../src/features/sandbox/diagrams";
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

test("a Graphviz drawing is put in the diagram skin on the dark canvas", () => {
  const drawing = (paper: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><g id="graph0" class="graph"><polygon fill="${paper}" stroke="none" points="0,0 100,0 100,40 0,40"/><g class="cluster"><path fill="none" stroke="#bfc0c0" d="M0,0"/><text font-family="Courier,monospace">src</text></g><g class="node"><path fill="#ffffff" stroke="#2d3142" fill-opacity="0.5" d="M0,0"/><text font-family="Helvetica,sans-Serif" font-size="13.00">app.ts</text></g><g class="node"><path fill="#ddfeff" stroke="#000000" d="M0,0"/></g><g class="edge"><path fill="none" stroke="#EB6C36" stroke-opacity="0.2" stroke-dasharray="5,2" d="M0,0"/><text font-family="Times,serif">uses</text></g></g></svg>`;
  const read = (markup: string | undefined) =>
    new DOMParser().parseFromString(markup ?? "", "image/svg+xml")
      .documentElement;
  const texts = (svg: Element) => [...svg.getElementsByTagName("text")];

  const svg = read(prepareSvg(drawing("#ffffff"), { skin: true })?.markup);
  const paths = [...svg.getElementsByTagName("path")];
  // The page is gone, so the editor shows through, as behind Mermaid's.
  expect(svg.getElementsByTagName("polygon")[0]?.getAttribute("fill")).toBe(
    "none",
  );
  // The skin's light roles become its dark ones exactly, at the opacity
  // they were drawn at: a container's rule, a node's fill and its ink.
  expect(paths[0]?.getAttribute("stroke")).toBe("#474848");
  expect(paths[1]?.getAttribute("fill")).toBe("#282828");
  expect(paths[1]?.getAttribute("fill-opacity")).toBe("0.5");
  expect(paths[1]?.getAttribute("stroke")).toBe("#f5f5f5");
  // The accent, however it was spelled, and its dash made the skin's.
  expect(paths[3]?.getAttribute("stroke")).toBe("#f08a59");
  expect(paths[3]?.getAttribute("stroke-opacity")).toBe("0.2");
  expect(paths[3]?.getAttribute("stroke-dasharray")).toBe("5,4");
  // Any other color is turned by lightness: a pale fill keeps its hue, dark
  // and muted rather than vivid, and black becomes light.
  expect(paths[2]?.getAttribute("fill")).toBe("#244546");
  expect(paths[2]?.getAttribute("stroke")).toBe("#d9d9d9");
  // What draws nothing is left as it is.
  expect(paths[0]?.getAttribute("fill")).toBe("none");
  // Text with no color of its own inherits ink.
  expect(svg.getAttribute("fill")).toBe("#f5f5f5");
  // The faces Graphviz measured are drawn as the skin's: Courier as Geist
  // Mono, Helvetica as Geist, a node's name at a name's weight. A face it
  // was asked for by name is kept.
  const [folder, name, label] = texts(svg);
  expect(folder?.getAttribute("font-family")).toMatch(/^"Geist Mono Variable"/);
  expect(name?.getAttribute("font-family")).toMatch(/^"Geist Variable"/);
  expect(name?.getAttribute("font-weight")).toBe("600");
  // Drawn a tenth smaller: Geist at that weight runs a tenth wider.
  expect(name?.getAttribute("font-size")).toBe("11.70");
  expect(label?.getAttribute("font-family")).toBe("Times,serif");

  // A graph that chose a dark page keeps its colors, though not its faces.
  const dark = read(prepareSvg(drawing("#101010"), { skin: true })?.markup);
  expect(dark.getElementsByTagName("path")[2]?.getAttribute("fill")).toBe(
    "#ddfeff",
  );
  expect(texts(dark)[1]?.getAttribute("font-family")).toMatch(/^"Geist/);
  // Mermaid's drawings are never turned.
  const untouched = read(prepareSvg(drawing("#ffffff"))?.markup);
  expect(untouched.getElementsByTagName("path")[2]?.getAttribute("fill")).toBe(
    "#ddfeff",
  );
  expect(texts(untouched)[1]?.getAttribute("font-family")).toBe(
    "Helvetica,sans-Serif",
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

test("an SVG from a repository's build cannot run, embed or fetch anything", () => {
  const prepared = prepareSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
      <style>@import url(https://evil.test/a.css); .n { fill: url(https://evil.test/x.png); stroke: url(#grad); } .q { fill: url("#quoted"); stroke: url('https://evil.test/q.png'); }</style>
      <a href="https://example.test/ok"><text>ok</text></a>
      <a id="bad" href="#"><set attributeName="href" to="javascript:alert(1)"/><text>bad</text></a>
      <animate attributeName="href" to="javascript:alert(1)"/>
      <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe><span>label</span></div></foreignObject>
      <image href="https://evil.test/track.png" width="1" height="1"/>
      <image href="data:image/png;base64,AAAA" width="1" height="1"/>
      <use href="https://evil.test/sprite.svg#x"/>
      <use href="#local"/>
      <rect style="fill: url(https://evil.test/p.png)" width="1" height="1"/>
    </svg>`,
  );
  const markup = prepared?.markup ?? "";
  expect(markup).not.toMatch(/evil\.test/);
  expect(markup).not.toMatch(/javascript:/i);
  expect(markup).not.toMatch(/<iframe|<set|<animate|srcdoc/i);
  // What a drawing needs is kept: its labels, a link out, an inline
  // picture and references within it.
  expect(markup).toContain("label");
  expect(markup).toContain('href="https://example.test/ok"');
  expect(markup).toContain("data:image/png;base64,AAAA");
  expect(markup).toContain('href="#local"');
  expect(markup).toContain("url(#grad)");
  expect(markup).toContain('url("#quoted")');
});

test("a graph too large to lay out is refused at once, not drawn for minutes", async () => {
  await expect(
    renderDiagram("dot", `digraph { ${"a -> b; ".repeat(DOT_SOURCE_MAX)} }`),
  ).rejects.toThrow(/too large to draw/);
});
