/**
 * The ways into the platform a workspace has not taken yet, each with what
 * it pays back.
 *
 * A card says what the platform does with the tool, how much it costs to try
 * (seconds, no model call), and has one button. The first card given is the
 * one home recommends, and is drawn as such; a person who may not connect
 * tools is told who can, instead of being shown a button that would be
 * refused.
 */

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

export interface PathCard {
  key: string;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** A short line under the description: what it costs, what it reads. */
  note?: string | undefined;
  /** Absent when the person may not take this path themselves. */
  action?: { label: string; onSelect: () => void } | undefined;
  /** Said in place of the button when there is no action. */
  unavailable?: string | undefined;
}

export function PathCards({ paths }: { paths: PathCard[] }) {
  if (paths.length === 0) return null;
  return (
    <ul
      className={`grid gap-3 ${paths.length >= 3 ? "md:grid-cols-3" : "sm:grid-cols-2"}`}
      data-testid="path-cards"
    >
      {paths.map((path, index) => {
        const recommended = index === 0;
        return (
          <li
            key={path.key}
            data-path={path.key}
            className={`flex flex-col gap-3 rounded-lg border p-4 ${recommended ? "border-foreground/25 bg-muted/30" : ""}`}
          >
            <span className="flex items-center gap-2">
              <span className="bg-background grid size-8 shrink-0 place-items-center rounded-md border [&_svg]:size-4">
                {path.icon}
              </span>
              <span className="text-sm font-medium">{path.title}</span>
            </span>
            <span className="text-muted-foreground text-sm leading-snug">
              {path.description}
            </span>
            {path.note !== undefined && (
              <span className="text-muted-foreground/80 text-xs">
                {path.note}
              </span>
            )}
            <span className="mt-auto pt-1">
              {path.action !== undefined ? (
                <Button
                  size="sm"
                  variant={recommended ? "default" : "outline"}
                  className="gap-1.5"
                  onClick={path.action.onSelect}
                >
                  {path.action.label}
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : (
                <span className="text-muted-foreground text-xs">
                  {path.unavailable ?? "An owner or admin can do this."}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
