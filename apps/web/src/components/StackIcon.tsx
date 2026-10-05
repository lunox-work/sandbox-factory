/**
 * A technology's logo, beside its name in a tech stack.
 *
 * The logos are files in `src/assets/stack/`, written by
 * `scripts/stack-icons.mjs`: vscode-icons' file icons where that set has
 * one, so a stack reads like an editor's file tree, and another set's
 * colour logo on the same grid where it does not. A logo drawn for one
 * theme only comes as two files, and both are rendered with the other
 * hidden, so the switch follows the theme without script.
 *
 * Each is decoration. It is always beside the name, so it is hidden from
 * assistive technology rather than announced a second time.
 *
 * The catalog is _defined_ in `packages/core`, and knows nothing of these.
 * `stack-icon.test.tsx` walks it and fails for an entry with no file here,
 * which is what keeps a new one from shipping with the fallback.
 */

import { Box } from "lucide-react";
import { canonicalStackName } from "sandbox-factory";

import { cn } from "@/lib/utils";

/**
 * Not inlined into the bundle, as files this small otherwise would be: there
 * are over a hundred, and a page shows only the few in its stacks.
 */
const FILES = import.meta.glob<string>("../assets/stack/*.svg", {
  eager: true,
  query: "?no-inline",
  import: "default",
});

interface Logo {
  readonly light: string;
  readonly dark: string;
}

const LOGOS = new Map<string, { light?: string; dark?: string }>();
for (const [path, url] of Object.entries(FILES)) {
  const match = /\/([a-z0-9]+)(?:\.(light|dark))?\.svg$/.exec(path);
  const slug = match?.[1];
  if (slug === undefined) continue;
  const logo = LOGOS.get(slug) ?? {};
  const theme = match?.[2];
  if (theme !== "dark") logo.light = url;
  if (theme !== "light") logo.dark = url;
  LOGOS.set(slug, logo);
}

/**
 * Technologies shown with another's logo: their own is the same mark, or no
 * set has one and the language or platform they are built on stands in.
 *
 * A map, not an object: the name is whatever a person typed, and an
 * object would answer `constructor` with a function.
 */
const SAME_AS: ReadonlyMap<string, string> = new Map([
  ["React Native", "React"],
  ["SvelteKit", "Svelte"],
  ["ASP.NET Core", ".NET"],
  ["Echo", "Go"],
  ["Fiber", "Go"],
  ["Axum", "Rust"],
  ["AWS CDK", "AWS"],
]);

/**
 * The file name a technology's logo is kept under: Simple Icons' rule, so
 * `Node.js` is `nodedotjs` and `C++` is `cplusplus`, and `#` read as `sharp`.
 */
export function stackIconSlug(name: string): string {
  const canonical = canonicalStackName(name);
  return (SAME_AS.get(canonical) ?? canonical)
    .toLowerCase()
    .replaceAll("+", "plus")
    .replaceAll(".", "dot")
    .replaceAll("#", "sharp")
    .replaceAll("&", "and")
    .replace(/[^a-z0-9]/g, "");
}

/** A technology's logo for each theme, if it has one. */
export function stackLogo(name: string): Logo | undefined {
  const logo = LOGOS.get(stackIconSlug(name));
  if (logo?.light === undefined || logo.dark === undefined) return undefined;
  return { light: logo.light, dark: logo.dark };
}

export function StackIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const logo = stackLogo(name);
  if (logo === undefined) {
    // A name the catalog lacks: a plain box, in the text's colour, so it
    // reads as "a technology" without claiming to be anyone's mark.
    return (
      <Box
        aria-hidden="true"
        className={cn("text-muted-foreground shrink-0", className)}
      />
    );
  }
  if (logo.light === logo.dark) {
    return (
      <img
        src={logo.light}
        alt=""
        loading="lazy"
        draggable={false}
        className={cn("shrink-0", className)}
      />
    );
  }
  // Lazy, so the hidden theme's file is never fetched: a browser defers a
  // lazy image until it is laid out, and `display: none` never is.
  return (
    <>
      <img
        src={logo.light}
        alt=""
        loading="lazy"
        draggable={false}
        className={cn("shrink-0 dark:hidden", className)}
      />
      <img
        src={logo.dark}
        alt=""
        loading="lazy"
        draggable={false}
        className={cn("hidden shrink-0 dark:block", className)}
      />
    </>
  );
}
