/**
 * Tests for the tech stack logos.
 *
 * What a technology is lives in `packages/core`; what it looks like lives in
 * the web app, as files `scripts/stack-icons.mjs` writes. These are what keep
 * the two together: the catalog is walked here, so an entry added there
 * without a logo fails this file rather than shipping the fallback.
 */

import { render } from "./render";
import { STACK_CATALOG } from "sandbox-factory";
import { expect, test } from "vitest";

import {
  StackIcon,
  stackIconSlug,
  stackLogo,
} from "../src/components/StackIcon";

test("every technology in the catalog has a logo in both themes", () => {
  const missing = STACK_CATALOG.filter(
    ({ name }) => stackLogo(name) === undefined,
  ).map(({ name }) => `${name} (${stackIconSlug(name)}.svg)`);
  expect(missing).toEqual([]);
});

test("every logo file is one the catalog shows", () => {
  // Keys only: nothing is loaded.
  const files = Object.keys(import.meta.glob("../src/assets/stack/*.svg"));
  const shown = new Set(STACK_CATALOG.map(({ name }) => stackIconSlug(name)));
  const unused = files
    .map((path) => /\/([a-z0-9]+)(?:\.(?:light|dark))?\.svg$/.exec(path)?.[1])
    .filter((slug) => slug === undefined || !shown.has(slug));
  expect(unused).toEqual([]);
});

test("the name is read as the catalog reads it", () => {
  // Another spelling of the same technology, and a technology drawn with
  // another's mark.
  expect(stackLogo("postgres")).toEqual(stackLogo("PostgreSQL"));
  expect(stackLogo("React Native")).toEqual(stackLogo("React"));
  expect(stackIconSlug("C++")).toBe("cplusplus");
  expect(stackIconSlug("C#")).toBe("csharp");
  expect(stackIconSlug("Node.js")).toBe("nodedotjs");
});

test("a logo drawn for one theme comes with one for the other", () => {
  // vscode-icons draws Next.js white, for the editor's dark theme.
  const next = stackLogo("Next.js");
  expect(next?.light).not.toBe(next?.dark);
  const { container } = render(<StackIcon name="Next.js" />);
  const images = [...container.querySelectorAll("img")];
  expect(images.map((image) => image.className)).toEqual([
    "shrink-0 dark:hidden",
    "hidden shrink-0 dark:block",
  ]);
  // Python's reads on both.
  const python = stackLogo("Python");
  expect(python?.light).toBe(python?.dark);
});

test("a name the catalog lacks gets the fallback, not a hole", () => {
  for (const name of ["Our own queue", "constructor"]) {
    expect(stackLogo(name)).toBeUndefined();
    const { container } = render(<StackIcon name={name} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  }
});

test("the logos are decoration, sized by whoever places them", () => {
  // Each sits beside the name, so announcing it would say the name twice.
  for (const name of ["Python", "Next.js", "Our own queue"]) {
    const { container } = render(<StackIcon name={name} className="size-4" />);
    for (const image of container.querySelectorAll("img")) {
      expect(image.getAttribute("alt")).toBe("");
      expect(image.classList.contains("size-4")).toBe(true);
    }
    const svg = container.querySelector("svg");
    if (svg !== null) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.classList.contains("size-4")).toBe(true);
    }
  }
});
