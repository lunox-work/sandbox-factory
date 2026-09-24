/*
 * No focus ring left behind by a click.
 *
 * A browser decides whether script focus matches `:focus-visible` by how focus
 * last moved: after a click has focused something, a later `.focus()` inherits
 * "not visible". Radix's menu triggers cancel `pointerdown`, so the menu can
 * take focus without the trigger competing for it, and that click never moves
 * focus at all. Left with nothing to go on, Chrome and Safari both treat the
 * next script focus as keyboard focus. So closing a menu with the mouse handed
 * focus back to its trigger with a ring around it, Safari ringed the heading
 * the app focuses on every navigation, and each ring stayed until the next
 * click somewhere else.
 *
 * The fix is in `focus()` itself rather than in each caller, because the focus
 * return is Radix's own code, and the next hand-rolled one would bring the bug
 * back. Between a pointer press and the next key press, a script focus that
 * does not say otherwise asks for no ring. A key press ends that, so Escape
 * out of a menu, or Enter on a link, still rings wherever focus lands.
 *
 * Text fields are left to the browser, which rings them however they were
 * reached because they are where typing will go.
 */

/** `<input>` types that are pressed or picked rather than typed into. */
const CONTROL_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Held alone, these are half a shortcut, not keyboard navigation. */
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

/**
 * Keys that move somewhere even with a modifier held: Alt+Left and Cmd+[ go
 * back through history, and the app then focuses the new page's heading. That
 * is keyboard navigation, so it keeps its ring. Other shortcuts, like Cmd+C
 * after a click, move nothing and leave pointer mode alone.
 */
const NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "[",
  "]",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

function takesText(element: HTMLElement): boolean {
  if (element.tagName === "TEXTAREA") {
    return true;
  }
  if (element.tagName === "INPUT") {
    return !CONTROL_INPUT_TYPES.has((element as HTMLInputElement).type);
  }
  return element.isContentEditable;
}

/**
 * Installs the guard and returns what undoes it. Called once, before
 * the app renders, so every focus call the app or a library makes goes
 * through it.
 */
export function installPointerFocus(): () => void {
  const prototype = HTMLElement.prototype;
  const browserFocus = prototype.focus;
  let pointer = false;

  const onPointerDown = () => {
    pointer = true;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) {
      return;
    }
    if (
      (event.metaKey || event.ctrlKey || event.altKey) &&
      !NAVIGATION_KEYS.has(event.key)
    ) {
      return;
    }
    pointer = false;
  };

  // Capture phase, so a handler that stops propagation cannot hide either.
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);

  prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (!pointer || options?.focusVisible !== undefined || takesText(this)) {
      browserFocus.call(this, options);
      return;
    }
    browserFocus.call(this, { ...options, focusVisible: false });
  };

  return () => {
    prototype.focus = browserFocus;
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}
