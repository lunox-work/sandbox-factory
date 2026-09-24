/**
 * A profile picture shown beside its editable identity fields, and the way to
 * change it.
 *
 * At rest it is just the face. Given `edit`, the face becomes a button: hover
 * or focus shows a camera, and pressing it offers "Upload picture" and — when
 * there is one — "Remove picture". Removing brings back the identicon, which
 * was underneath all along.
 *
 * A refusal ("Use a PNG, JPEG, WebP or GIF.") appears as a small callout under
 * the picture, where the thing being refused is, as `EditableField` does for
 * text. It floats rather than pushing the row down, because the row is laid
 * out around a 64px face and a line of text beneath it would reflow the card.
 */

import { Camera, Loader2 } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import { EntityAvatar, type AvatarShape } from "@/components/Avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { ACCEPTED_TYPES } from "../avatars";

const SIZE = "size-16";

export interface AvatarEdit {
  /** A save is in flight somewhere on the page. */
  busy?: boolean;
  /** Resolves to the server's reason on a refusal, and nothing on success. */
  onUpload: (file: File) => Promise<string | void>;
  onRemove: () => Promise<string | void>;
}

export function AvatarField({
  id,
  image,
  shape,
  edit,
  readOnlyReason,
  label = "Change picture",
}: {
  id: string;
  image?: string | null | undefined;
  shape: AvatarShape;
  /** Present when the viewer may change this picture. */
  edit?: AvatarEdit | undefined;
  /**
   * Why the picture cannot be changed here, when that is worth saying — a
   * personal workspace's face is changed on the account page. Shown as the
   * face's tooltip.
   */
  readOnlyReason?: string | undefined;
  /** The trigger's accessible name. */
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (edit === undefined) {
    return (
      <span title={readOnlyReason} className="shrink-0">
        <EntityAvatar id={id} image={image} shape={shape} className={SIZE} />
      </span>
    );
  }

  // Held in a const so the closures below keep the narrowing.
  const actions = edit;
  const hasPicture = image !== null && image !== undefined && image !== "";
  const disabled = working || actions.busy === true;

  async function run(action: () => Promise<string | void>) {
    setWorking(true);
    setError(null);
    try {
      const failure = await action();
      if (typeof failure === "string") {
        setError(failure);
      }
    } finally {
      setWorking(false);
    }
  }

  function picked(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared so picking the same file again after a refusal still fires.
    event.target.value = "";
    if (file !== undefined) {
      void run(() => actions.onUpload(file));
    }
  }

  return (
    <div className="relative shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label={label}
          className={cn(
            "group/avatar focus-visible:ring-ring/50 relative block outline-none focus-visible:ring-[3px] disabled:cursor-default",
            shape === "circle" ? "rounded-full" : "rounded-lg",
          )}
        >
          <EntityAvatar id={id} image={image} shape={shape} className={SIZE} />
          {/* The overlay follows the face's own shape, so a square stays square. */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-0 grid place-items-center bg-black/45 text-white transition-opacity",
              shape === "circle" ? "rounded-full" : "rounded-lg",
              working
                ? "opacity-100"
                : "opacity-0 group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100",
            )}
          >
            {working ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Camera className="size-5" strokeWidth={1.8} />
            )}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => input.current?.click()}>
            Upload picture…
          </DropdownMenuItem>
          {hasPicture && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void run(() => actions.onRemove())}
            >
              Remove picture
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={input}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload picture"
        onChange={picked}
      />

      {error !== null && (
        <p
          role="alert"
          className="bg-popover text-destructive absolute top-full left-0 z-10 mt-1.5 w-max max-w-64 rounded-md border px-2.5 py-1.5 text-xs shadow-sm"
        >
          {error}
        </p>
      )}
    </div>
  );
}
