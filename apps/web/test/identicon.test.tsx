/**
 * Tests for the generated avatar and the component that chooses between it and
 * a real picture.
 *
 * What the grid looks like for a given id is `packages/shared`'s contract and
 * is pinned there. What these assert is the rendering: that the padding
 * keeping corner cells inside the circular crop is present, that the grid is
 * one path rather than twenty-five rects, and that a picture wins over the
 * identicon while a missing or broken one does not.
 */

import { render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { EntityAvatar } from "../src/components/Avatar";
import { AvatarField } from "../src/components/AvatarField";
import { Identicon } from "../src/components/Identicon";

/*
 * Radix decides between the picture and the fallback by constructing
 * `new window.Image()` and reading `complete` and `naturalWidth` off it. jsdom
 * creates the object but fetches nothing, so without this stub no picture ever
 * loads and the fallback tests would pass for the wrong reason.
 *
 * A real jsdom `img` with the fetch faked, as `nav.test.tsx` does it: setting
 * `src` dispatches `load` on the next tick and reports a decoded 1x1.
 */
function LoadingImage(this: unknown) {
  const element = document.createElement("img");

  Object.defineProperty(element, "complete", { value: true });
  Object.defineProperty(element, "naturalWidth", { value: 1 });

  let source = "";
  Object.defineProperty(element, "src", {
    get: () => source,
    set: (value: string) => {
      source = value;
      element.setAttribute("src", value);
      setTimeout(() => element.dispatchEvent(new Event("load")), 0);
    },
  });

  return element;
}

vi.stubGlobal("Image", LoadingImage);

/** As `packages/shared/test/identicon.test.ts` pins it for this seed. */
const USER_1_D =
  "M1 0h1v1h-1zM3 0h1v1h-1zM1 1h1v1h-1zM3 1h1v1h-1zM1 2h1v1h-1z" +
  "M3 2h1v1h-1zM0 3h1v1h-1zM1 3h1v1h-1zM2 3h1v1h-1zM3 3h1v1h-1z" +
  "M4 3h1v1h-1zM0 4h1v1h-1zM2 4h1v1h-1zM4 4h1v1h-1z";

test("an identicon is one path in a padded viewBox", () => {
  const { container } = render(<Identicon seed="user_1" />);

  const svg = container.querySelector("svg");
  // A cell of padding on every side. Unpadded, only 14% of each corner cell
  // survives the circular crop and a filled corner renders as a sliver.
  expect(svg?.getAttribute("viewBox")).toBe("-1 -1 7 7");

  // One path for the whole grid: abutting rects at 3.43 device pixels
  // anti-alias independently and show seams through what should be one block.
  expect(container.querySelectorAll("path")).toHaveLength(1);
  expect(container.querySelectorAll("rect")).toHaveLength(0);
  expect(container.querySelector("path")?.getAttribute("d")).toBe(USER_1_D);
});

test("an identicon is hidden from assistive technology", () => {
  // Decorative: the name beside or behind the avatar carries the meaning, and
  // announcing a pixel grid a second time is noise.
  const { container } = render(<Identicon seed="user_1" />);

  const svg = container.querySelector("svg");
  expect(svg?.getAttribute("aria-hidden")).toBe("true");
  expect(svg?.getAttribute("focusable")).toBe("false");
});

test("the fill takes its lightness and chroma from the theme", () => {
  // The hue is the only part of the colour the component decides; the other
  // two are per-theme tokens, so a dark card gets a lighter grid without this
  // component knowing which theme is on.
  const { container } = render(<Identicon seed="user_1" />);

  expect(container.querySelector("path")?.getAttribute("fill")).toBe(
    "oklch(var(--identicon-l) var(--identicon-c) 38)",
  );
});

test("the same id always gives the same face", () => {
  const first = render(<Identicon seed="org_globex" />);
  const firstD = first.container.querySelector("path")?.getAttribute("d");
  first.unmount();

  const second = render(<Identicon seed="org_globex" />);

  expect(second.container.querySelector("path")?.getAttribute("d")).toBe(
    firstD,
  );
});

test("different ids give different faces", () => {
  const a = render(<Identicon seed="user_1" />);
  const aD = a.container.querySelector("path")?.getAttribute("d");
  a.unmount();

  const b = render(<Identicon seed="user_2" />);

  expect(b.container.querySelector("path")?.getAttribute("d")).not.toBe(aD);
});

test("an avatar with no picture shows the identicon", async () => {
  const { container } = render(<EntityAvatar id="user_1" shape="circle" />);

  // Radix renders the fallback asynchronously, after checking for an image.
  await waitFor(() => {
    expect(container.querySelector("path")?.getAttribute("d")).toBe(USER_1_D);
  });
  expect(container.querySelector("img")).toBeNull();
});

test("an avatar with a picture shows the picture", async () => {
  const { container } = render(
    <EntityAvatar
      id="user_1"
      image="https://example.test/alice.png"
      shape="circle"
    />,
  );

  await waitFor(() => {
    expect(container.querySelector("img")).not.toBeNull();
  });

  const img = container.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://example.test/alice.png");
  // The provider's CDN does not need to know who is using this app.
  expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

test("the identicon does not flash while a picture is still loading", async () => {
  /*
   * Radix shows the fallback *while* the image is in flight, not only when it
   * fails, so without the delay a saturated grid appears for a frame on every
   * page load. Initials flashing was quiet; this is not.
   *
   * The picture has to be genuinely pending to see it: against one that has
   * already loaded or already failed, the assertion passes whether the delay
   * is there or not. Measured here at 100ms, an undelayed fallback is on
   * screen and a delayed one is not.
   */
  vi.stubGlobal("Image", function PendingImage() {
    const element = document.createElement("img");
    // Radix reads both, and treats "not complete" as still loading.
    Object.defineProperty(element, "complete", { value: false });
    Object.defineProperty(element, "naturalWidth", { value: 0 });
    let source = "";
    Object.defineProperty(element, "src", {
      get: () => source,
      set: (value: string) => {
        source = value;
      },
    });
    return element;
  });

  try {
    const { container } = render(
      <EntityAvatar
        id="user_1"
        image="https://example.test/pending.png"
        shape="circle"
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(container.querySelector("path")).toBeNull();
  } finally {
    // Back to the stub that loads: `unstubAllGlobals` would drop it too, and
    // every later test that needs a picture would hang on jsdom's own Image.
    vi.stubGlobal("Image", LoadingImage);
  }
});

test("an empty picture is treated as none at all", async () => {
  /*
   * Better Auth can hand back "" as well as null for an account with no
   * picture.
   *
   * Radix turns out to skip an empty `src` on its own — it never constructs
   * the probe — so this asserts the outcome rather than the guard in
   * `EntityAvatar` that also produces it. Dropping that guard would not fail
   * this test; it stays because passing a src we know is empty and relying on
   * a library to ignore it is worse than not passing it.
   */
  const { container } = render(
    <EntityAvatar id="user_1" image="" shape="circle" />,
  );

  await waitFor(() => {
    expect(container.querySelector("path")?.getAttribute("d")).toBe(USER_1_D);
  });
  expect(container.querySelector("img")).toBeNull();
});

test("a square avatar squares its fallback too", async () => {
  // The trap this guards: shadcn's `AvatarFallback` carries its own
  // `rounded-full`, so rounding only the root leaves a muted circle inside a
  // rounded square.
  const { container } = render(<EntityAvatar id="org_globex" shape="square" />);

  const root = container.querySelector('[data-slot="avatar"]');
  expect(root?.className).toContain("rounded-lg");

  await waitFor(() => {
    expect(
      container.querySelector('[data-slot="avatar-fallback"]'),
    ).not.toBeNull();
  });
  const fallback = container.querySelector('[data-slot="avatar-fallback"]');
  expect(fallback?.className).toContain("rounded-[inherit]");
});

test("a circular avatar leaves the shape to the default", () => {
  const { container } = render(<EntityAvatar id="user_1" shape="circle" />);

  const root = container.querySelector('[data-slot="avatar"]');
  expect(root?.className).toContain("rounded-full");
  expect(root?.className).not.toContain("rounded-lg");
});

test("the settings avatar does not advertise an unavailable upload", () => {
  const { container } = render(<AvatarField id="user_1" shape="circle" />);

  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
});

test("the settings avatar keeps the requested shape", () => {
  const { container } = render(<AvatarField id="org_globex" shape="square" />);

  const avatar = container.querySelector('[data-slot="avatar"]');
  expect(avatar?.className).toContain("rounded-lg");
  expect(avatar?.className).not.toContain("rounded-full");
});

test("the settings avatar shows the generated face at a readable size", () => {
  const { container } = render(<AvatarField id="user_1" shape="circle" />);

  // Larger than the rail's 24px: here the picture is the subject, and a 5x5
  // grid reads as texture when it is small.
  const avatar = container.querySelector('[data-slot="avatar"]');
  expect(avatar?.className).toContain("size-16");
  expect(avatar?.querySelector("path")?.getAttribute("d")).toBe(USER_1_D);
});

test("the settings avatar prefers a real picture over the generated one", async () => {
  const { container } = render(
    <AvatarField
      id="user_1"
      image="https://example.test/alice.png"
      shape="circle"
    />,
  );

  await waitFor(() => {
    expect(container.querySelector("img")).not.toBeNull();
  });
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.test/alice.png",
  );
});

test("an organization's settings avatar is a rounded square", () => {
  const { container } = render(<AvatarField id="org_globex" shape="square" />);

  expect(container.querySelector('[data-slot="avatar"]')?.className).toContain(
    "rounded-lg",
  );
});
