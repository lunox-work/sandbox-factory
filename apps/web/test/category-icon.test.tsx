/**
 * Tests for the category icons.
 *
 * What a category is lives in `packages/core`; what it looks like lives in
 * the web app. These are what keep the two together: the registry is walked
 * here, so a category added there without a drawing fails this file rather
 * than shipping the fallback.
 */

import { render } from "./render";
import { CATEGORIES } from "sandbox-factory";
import { expect, test } from "vitest";

import { CategoryIcon } from "../src/CategoryIcon";

function drawn(category: string) {
  const { container } = render(<CategoryIcon category={category} />);
  const svg = container.querySelector("svg");
  if (svg === null) throw new Error(`no icon rendered for ${category}`);
  return svg;
}

test("every category in the registry has a drawing of its own", () => {
  const drawings = CATEGORIES.map(({ id }) => {
    const svg = drawn(id);
    expect(svg.getAttribute("data-category-icon")).toBe(id);
    return svg.innerHTML;
  });
  expect(drawings).toHaveLength(6);
  expect(new Set(drawings).size).toBe(drawings.length);
});

test("a category without a drawing gets the fallback, not a hole", () => {
  // Retired from the registry but still stored on an old run, or added to
  // the registry by a deploy the browser's bundle predates.
  const svg = drawn("no-such-category");
  expect(svg.hasAttribute("data-category-icon")).toBe(false);
  expect(svg.innerHTML).not.toBe("");
  // The id arrives from stored JSON: a bare lookup would find `constructor`
  // on any object and try to render a function.
  expect(drawn("constructor").hasAttribute("data-category-icon")).toBe(false);
});

test("the icons are decoration, sized by whoever places them", () => {
  // Each sits beside the label that names the category, so announcing it
  // would say the category twice.
  for (const category of ["paper-cuts", "no-such-category"]) {
    const { container } = render(
      <CategoryIcon category={category} className="size-4" />,
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("size-4")).toBe(true);
  }
});
