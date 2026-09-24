/**
 * Tests for the guard that keeps a click from ending in a focus ring.
 *
 * jsdom does not implement `:focus-visible`, so these assert on what reaches
 * the browser's own `focus()`: the options a call is forwarded with decide
 * whether a real browser draws the ring, and that is the whole of the fix.
 */

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi, type Mock } from "vitest";

import { installPointerFocus } from "../src/lib/pointer-focus";

const nativeFocus = HTMLElement.prototype.focus;
let focus: Mock<HTMLElement["focus"]>;
let uninstall: () => void;

beforeEach(() => {
  // The stand-in the guard wraps, so each forwarded call can be read back.
  focus = vi.fn<HTMLElement["focus"]>();
  HTMLElement.prototype.focus = focus;
  uninstall = installPointerFocus();
});

afterEach(() => {
  uninstall();
  HTMLElement.prototype.focus = nativeFocus;
  document.body.replaceChildren();
});

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  document.body.append(node);
  return node;
}

test("a script focus after a click asks for no ring", () => {
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  trigger.focus();

  expect(focus).toHaveBeenCalledWith({ focusVisible: false });
});

test("the caller's other options survive", () => {
  const heading = element("h1");

  fireEvent.pointerDown(document.body);
  heading.focus({ preventScroll: true });

  expect(focus).toHaveBeenCalledWith({
    preventScroll: true,
    focusVisible: false,
  });
});

test("a key press hands the ring back, so keyboard users still see it", () => {
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });
  trigger.focus();

  expect(focus).toHaveBeenCalledWith(undefined);
});

test("a modifier or a shortcut does not count as keyboard use", () => {
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "Shift" });
  fireEvent.keyDown(document.body, { key: "c", metaKey: true });
  trigger.focus();

  expect(focus).toHaveBeenCalledWith({ focusVisible: false });
});

test("before any interaction, focus is left as the browser decides", () => {
  element("button").focus();

  expect(focus).toHaveBeenCalledWith(undefined);
});

test("a text field keeps its ring, since it is where typing goes", () => {
  const field = element("input");
  const notes = element("textarea");

  fireEvent.pointerDown(document.body);
  field.focus();
  notes.focus();

  expect(focus).toHaveBeenNthCalledWith(1, undefined);
  expect(focus).toHaveBeenNthCalledWith(2, undefined);
});

test("an input that is really a control is treated as one", () => {
  const box = element("input");
  box.type = "checkbox";

  fireEvent.pointerDown(document.body);
  box.focus();

  expect(focus).toHaveBeenCalledWith({ focusVisible: false });
});

test("a caller that says what it wants is not overruled", () => {
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  trigger.focus({ focusVisible: true });

  expect(focus).toHaveBeenCalledWith({ focusVisible: true });
});

test("the focused element is the one the browser focuses", () => {
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  trigger.focus();

  expect(focus.mock.contexts[0]).toBe(trigger);
});

test("uninstalling restores the browser's focus and stops listening", () => {
  uninstall();
  const trigger = element("button");

  fireEvent.pointerDown(document.body);
  trigger.focus();

  expect(HTMLElement.prototype.focus).toBe(focus);
  expect(focus).toHaveBeenCalledWith();
  // Uninstalled already; the `afterEach` call must not throw a second time.
  uninstall = () => {};
});
