/** A profile image shown beside its editable identity fields. */
import { EntityAvatar, type AvatarShape } from "@/components/Avatar";

export function AvatarField({
  id,
  image,
  shape,
}: {
  id: string;
  image?: string | null;
  shape: AvatarShape;
}) {
  return (
    <EntityAvatar
      id={id}
      image={image}
      shape={shape}
      className="size-16 shrink-0"
    />
  );
}
