/**
 * Shared test setup.
 *
 * Runs for every suite, including `build-injection.test.ts`, which sets
 * `@vitest-environment node` and so has no DOM. Everything DOM-shaped here is
 * guarded on that.
 */

import { act, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(async () => {
  /*
   * Radix keeps a focus scope alive while a menu or popover is open, and
   * unmounting one mid-open leaves that teardown unsettled in jsdom — which
   * surfaces as the *next* test timing out rather than as a failure here.
   *
   * Dismissing anything still open first is what avoids it. Escape is the
   * documented way out of every Radix overlay, so one key covers menus,
   * dialogs and popovers alike.
   *
   * Inside `act`, and awaited, so the close and the focus return it triggers
   * both settle before `cleanup` unmounts. Dispatched bare, that teardown
   * lands unowned and React reports it against whichever test was open.
   */
  if (typeof document !== "undefined") {
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  }
  cleanup();
});

/*
 * Browser APIs jsdom does not implement, which Radix calls when a menu opens.
 * Without them the click throws instead of opening anything.
 *
 * Stubs, not implementations: jsdom performs no layout, so every box it could
 * measure is zero regardless. They exist so the calls return rather than
 * throw.
 */
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in globalThis)) {
    globalThis.ResizeObserver = class ResizeObserver {
      // The real constructor's signature, so callers passing a callback match.
      constructor(_callback: ResizeObserverCallback) {}
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  // Radix checks these before deciding whether a pointer interaction is a
  // drag. jsdom fires the events but does not implement pointer capture.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = (): boolean => false;
    Element.prototype.setPointerCapture = (): void => {};
    Element.prototype.releasePointerCapture = (): void => {};
  }

  // Used to keep a menu item in view as the arrow keys walk the list.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {};
  }

  /*
   * `:fullscreen` and `:modal` are the difference between a menu opening in
   * 20ms and in five seconds.
   *
   * Radix hides the rest of the page from screen readers while a menu is open,
   * which walks the tree asking each element whether it matches them. jsdom's
   * selector engine (nwsapi) implements neither, and its miss path is
   * quadratic rather than a cheap `false`: one open of a menu with a single
   * item measured ~18 million `:fullscreen` calls costing ~4.7s of the ~4.8s
   * total. The suite ran close enough to `testTimeout` that CI tipped over it
   * while the same tests passed locally.
   *
   * Answering `false` directly is correct, not just fast: jsdom has no
   * fullscreen and no top layer, so nothing in it is ever in either state.
   * Every other selector goes to the real implementation.
   */
  const matches = Element.prototype.matches;
  // Cast because the DOM types declare `matches` as a set of tag-name type
  // predicates, which no plain function can restate.
  Element.prototype.matches = function (this: Element, selectors: string) {
    if (selectors === ":fullscreen" || selectors === ":modal") return false;
    return matches.call(this, selectors);
  } as typeof matches;
}
