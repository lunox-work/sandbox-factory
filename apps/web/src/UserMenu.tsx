/**
 * The avatar at the foot of the rail, and the menu behind it.
 *
 * The menu is where the three things that used to sit in the todo header and
 * the page footer now live: who you are signed in as, sign out, and which
 * build this is. None of them is part of the task of writing todos, so none of
 * them earns permanent space on the screen.
 *
 * The build readout keeps every distinction the footer drew — release vs
 * commit, a dirty tree, and the API running a different sha — because those
 * are the facts a bug report needs. See `BuildDetails`.
 */

import { commitUrl, isIdentified, releaseUrl } from "@sandbox-factory/shared";
import type { BuildInfoDto } from "@sandbox-factory/shared";
import { ExternalLink, LogOut, Settings, User } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { fetchApiBuild, webBuild } from "./build";

export function UserMenu({
  name,
  email,
  image,
  onAccount,
  onSignOut,
}: {
  name: string;
  email?: string | undefined;
  image?: string | null;
  onAccount: () => void;
  onSignOut: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="ring-offset-background focus-visible:ring-ring cursor-pointer rounded-full transition-opacity outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-2 data-[state=open]:opacity-80"
        aria-label={`Account and settings — ${name}`}
      >
        {/* 24px in the rail, matching the reference: small enough to read as
            chrome rather than as content. The copy inside the menu is the
            larger one, where it identifies the account. */}
        <UserAvatar name={name} image={image} className="size-6 text-[10px]" />
      </DropdownMenuTrigger>

      {/*
        Opens to the right, its bottom edge level with the avatar — the
        reference's placement, and the one that keeps the menu clear of the
        list it sits over. `collisionPadding` keeps it off the viewport edge
        without letting Radix flip it to the far side of the rail.

        On a phone the rail is a bottom bar, and Radix re-sides the menu itself
        rather than letting it run off screen, so there is no breakpoint here.
      */}
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        className="w-60"
      >
        {/* Name over address, the address quieter: the pair identifies the
            account, and only one of them is worth reading twice. */}
        <DropdownMenuLabel className="px-2.5 pt-1.5 pb-2.5 font-normal">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {/* `truncate` and not a wrap: an address long enough to wrap would
              change the menu's height on open, which reads as a jump. */}
          {email !== undefined && (
            <span className="text-muted-foreground mt-0.5 block truncate text-xs">
              {email}
            </span>
          )}
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        {/* No "Todos" item: Home in the rail is that destination, and two
            affordances for one screen invite the wrong one. */}
        <DropdownMenuItem onSelect={onAccount}>
          <Settings />
          Account settings
        </DropdownMenuItem>

        {/* Destructive styling, but no confirmation: signing out costs one
            click to undo, so a dialog would be in the way rather than a
            safeguard. */}
        <DropdownMenuItem variant="destructive" onSelect={onSignOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <BuildDetails />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The avatar itself, used both as the trigger and inside the menu header. */
function UserAvatar({
  name,
  image,
  className,
}: {
  name: string;
  image?: string | null;
  className?: string;
}) {
  return (
    <Avatar className={className}>
      {/*
        Radix renders the fallback until the image loads and keeps it if the
        image errors, which is the case that matters: providers hand out avatar
        URLs that later 404.

        `image` is null for an account with no picture, and `AvatarImage`
        expects a string, so it is omitted entirely rather than passed as null.
      */}
      {image !== null && image !== undefined && image !== "" && (
        <AvatarImage
          src={image}
          alt=""
          // The provider's CDN does not need to know who is using this app.
          referrerPolicy="no-referrer"
        />
      )}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

/**
 * Up to two initials, from the first and last word of the name.
 *
 * "ada lovelace" gives "AL"; a single word gives one letter. A name that is
 * only punctuation or whitespace would give an empty circle, so it falls back
 * to a person glyph.
 */
function initials(name: string): React.ReactNode {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.[0] ?? "")
  ).toUpperCase();

  return letters === "" ? <User className="size-4" /> : letters;
}

/**
 * The build readout, moved here from the page footer.
 *
 * The text is plain: facts to read, not commands, so none of it is a
 * `DropdownMenuItem`. The links are, via `asChild`, because Radix moves focus
 * with the arrow keys over the items it knows about and its focus scope holds
 * Tab inside the open menu — a link that is neither is one no keyboard can
 * reach. `asChild` renders the anchor itself, so it stays a link.
 *
 * `onSelect` is left to its default, which closes the menu: following a link
 * navigates away, and a menu left open over the new page is the surprise.
 * Both open in a new tab, where the close is what returns focus to the
 * trigger.
 *
 * Exported for its own tests, which mount it in a bare open menu rather than
 * through the avatar: what they check is this subtree's content, not the menu
 * around it. `nav.test.tsx` is what pins the readout to the avatar's menu.
 */
export function BuildDetails() {
  const [apiBuild, setApiBuild] = useState<BuildInfoDto | undefined>(undefined);

  useEffect(() => {
    // Guards against setting state after unmount; StrictMode runs this effect
    // twice in development.
    let cancelled = false;
    void fetchApiBuild().then((info) => {
      if (!cancelled) {
        setApiBuild(info);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const href = commitUrl(webBuild);
  // Only when this build is a release; see `releaseUrl`.
  const release = releaseUrl(webBuild);

  // Only a definite disagreement is shown. No answer, or an unidentified build
  // on either side, is not a mismatch.
  const mismatched =
    apiBuild !== undefined &&
    isIdentified(apiBuild) &&
    isIdentified(webBuild) &&
    apiBuild.gitSha !== webBuild.gitSha;

  return (
    <div className="text-muted-foreground px-2 py-1.5 text-xs tabular-nums">
      <div className="flex items-center gap-1.5">
        <span className="text-foreground/70 font-medium">
          v{webBuild.version}
        </span>

        {isIdentified(webBuild) &&
          (href === undefined ? (
            <span className="font-mono">{webBuild.gitShortSha}</span>
          ) : (
            <DropdownMenuItem
              asChild
              // The row is laid out by the flex parent; the item only needs to
              // carry focus, so it keeps none of the default item padding.
              className="h-auto p-0 focus:bg-transparent"
            >
              <a
                className="hover:text-foreground focus-visible:text-foreground font-mono underline decoration-current/30 underline-offset-2 transition-colors"
                href={href}
                target="_blank"
                rel="noreferrer"
                title={buildTitle()}
              >
                {webBuild.gitShortSha}
              </a>
            </DropdownMenuItem>
          ))}

        {/* "dirty" is build-tooling vocabulary, and it is the state every local
            build is in. Said plainly, and only ever seen in development. */}
        {webBuild.dirty && (
          <span
            className="bg-foreground/8 rounded px-1.5 py-0.5 text-[0.68rem] leading-tight"
            title="Built from a working tree with uncommitted changes."
          >
            uncommitted
          </span>
        )}
      </div>

      {release !== undefined && (
        <DropdownMenuItem
          asChild
          className="mt-1.5 h-auto p-0 focus:bg-transparent"
        >
          <a
            className="hover:text-foreground focus-visible:text-foreground inline-flex items-center gap-1 underline decoration-current/30 underline-offset-2 transition-colors"
            href={release}
            target="_blank"
            rel="noreferrer"
            title="Release notes and signed artifacts for this version."
          >
            Release notes
            <ExternalLink className="size-3" />
          </a>
        </DropdownMenuItem>
      )}

      {mismatched && (
        <p
          // Amber, not red: a rolling deploy is not a failure and it resolves
          // itself on the next reload. The one thing here that reports
          // something in flight, so the one thing given a colour.
          className="mt-1.5 rounded bg-amber-500/12 px-1.5 py-1 font-mono text-[0.68rem] text-amber-700 dark:text-amber-400"
          title={mismatchTitle(apiBuild)}
        >
          API on {apiBuild.gitShortSha}
        </p>
      )}
    </div>
  );
}

/** The full sha and build time, for the person who needs to quote them. */
function buildTitle(): string {
  if (!isIdentified(webBuild)) {
    return "This build did not record the commit it came from.";
  }
  return `commit ${webBuild.gitSha}\nbuilt ${webBuild.buildTime}\nbranch ${webBuild.gitRef}`;
}

function mismatchTitle(apiBuild: BuildInfoDto): string {
  return (
    `This page was built from ${webBuild.gitShortSha}, ` +
    `the API is running ${apiBuild.gitShortSha}.\n` +
    "Usually a deploy in progress — reload to catch up."
  );
}
