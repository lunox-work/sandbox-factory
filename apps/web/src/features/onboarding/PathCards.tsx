/**
 * The ways into the platform a workspace has not taken yet.
 *
 * Kept simple: each card is the tool's mark, drawn large, at most one short
 * line under it — what it reads — and one button. A row of them,
 * centred, each one step smaller than the one before: the first given is the
 * one onboarding recommends, so it is the largest and the only filled
 * button, and the eye goes there first.
 *
 * A path that needs no tool at all — writing a bounty by hand — is drawn
 * with a dashed card and a bare button: it is there, but it is the way round
 * rather than the way in.
 *
 * The whole card is pressable, not just its button. The card takes the click
 * and the button has no handler of its own: its click — by pointer, Enter or
 * Space, or a screen reader — bubbles to the card, so a press fires once
 * wherever it lands. The button is still the one control per card: one stop
 * for the keyboard, one name for a screen reader.
 *
 * Not the button's hit area stretched over the card with a pseudo-element:
 * the button scales on press and its filled variant brightens on hover, and
 * a `scale` or `filter` makes the button the area's containing block, so the
 * area shrank back to the button mid-press and the click was lost.
 *
 * A person who may not connect tools is told who can, instead of being shown
 * a button that would be refused.
 */

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PathCard {
  key: string;
  /** The tool's mark, drawn at the card's size. */
  icon: ReactNode;
  /** What the card is, for a screen reader: the mark says it to the eye. */
  title: string;
  /** The one line under the mark: what it reads. Left out when the mark
   * and the button say it all. */
  note?: string | undefined;
  /**
   * Absent when the person may not take this path themselves. `label` is
   * the one word on the button; `name`, when given, is what a screen reader
   * hears, since two cards' "Connect" would otherwise sound alike. It starts
   * with the label, so speaking what is on screen still finds the button.
   */
  action?:
    | { label: string; name?: string | undefined; onSelect: () => void }
    | undefined;
  /** Said in place of the button when there is no action. */
  unavailable?: string | undefined;
  /** Drawn dashed: a way round rather than a way in. */
  dashed?: boolean | undefined;
}

/** Each card a step smaller than the one before it, the first the largest. */
const SIZES = [
  { card: "sm:w-64 p-7 gap-4", mark: "size-16 [&_svg]:size-16" },
  { card: "sm:w-56 p-6 gap-3.5", mark: "size-12 [&_svg]:size-12" },
  { card: "sm:w-48 p-5 gap-3", mark: "size-9 [&_svg]:size-9" },
] as const;

export function PathCards({ paths }: { paths: PathCard[] }) {
  if (paths.length === 0) return null;
  return (
    <ul
      className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
      data-testid="path-cards"
    >
      {paths.map((path, index) => {
        const recommended = index === 0;
        const size = SIZES[Math.min(index, SIZES.length - 1)] ?? SIZES[0];
        return (
          <li
            key={path.key}
            data-path={path.key}
            aria-label={path.title}
            // The button's own click bubbles here too; see the top of the file.
            onClick={path.action?.onSelect}
            // The hover in the brand's gradient is `.path-card` in index.css.
            data-actionable={path.action !== undefined ? "" : undefined}
            className={cn(
              "path-card flex w-full max-w-xs flex-col items-center rounded-lg border text-center",
              size.card,
              path.action !== undefined && "cursor-pointer",
              path.dashed === true
                ? "border-foreground/30 border-dashed"
                : recommended && "border-foreground/25 bg-muted/30",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "path-card-mark text-foreground grid shrink-0 place-items-center",
                size.mark,
              )}
            >
              {path.icon}
            </span>
            {path.note !== undefined && (
              <span className="text-muted-foreground text-sm">{path.note}</span>
            )}
            {path.action !== undefined ? (
              <Button
                size="sm"
                variant={
                  recommended
                    ? "default"
                    : path.dashed === true
                      ? "ghost"
                      : "outline"
                }
                type="button"
                aria-label={path.action.name}
              >
                {path.action.label}
              </Button>
            ) : (
              <span className="text-muted-foreground text-xs">
                {path.unavailable ?? "An owner or admin can do this."}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
