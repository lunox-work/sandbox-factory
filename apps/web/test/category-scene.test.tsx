/**
 * Tests for the scenes heading each card in "What task do teams outsource?".
 *
 * As with the icons, the registry in `packages/core` is walked here, so a
 * category added there without a scene fails this file rather than shipping
 * the fallback.
 */

import { render } from "./render";
import { CATEGORIES } from "sandbox-factory";
import { expect, test } from "vitest";

import { CategoryScene } from "../src/features/onboarding/CategoryScene";

function stage(category: string) {
  const { container } = render(<CategoryScene category={category} />);
  const scene = container.querySelector(".scene");
  if (scene === null) throw new Error(`no scene rendered for ${category}`);
  return scene;
}

test("every category in the registry has a scene of its own", () => {
  const scenes = CATEGORIES.map(({ id }) => {
    const scene = stage(id);
    expect(scene.getAttribute("data-scene-drawing")).toBe(id);
    return scene.innerHTML;
  });
  expect(scenes).toHaveLength(6);
  expect(new Set(scenes).size).toBe(scenes.length);
});

test("a category without a scene gets its icon, not a hole", () => {
  const scene = stage("no-such-category");
  expect(scene.hasAttribute("data-scene-drawing")).toBe(false);
  expect(scene.querySelector("svg")).not.toBeNull();
  expect(stage("constructor").hasAttribute("data-scene-drawing")).toBe(false);
});

test("a scene is decoration, hidden from assistive technology", () => {
  // The card's own text says everything the scene acts out.
  for (const { id } of CATEGORIES) {
    expect(stage(id).getAttribute("aria-hidden")).toBe("true");
  }
});
