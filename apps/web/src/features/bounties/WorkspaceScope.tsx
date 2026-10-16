/**
 * The bounties list narrowed to one of the person's workspaces.
 *
 * The list shows every workspace's bounties at once, and each row names
 * its workspace, so in one or two the filter is not needed; in several it
 * is how home's "N bounties" on a workspace opens that workspace's alone.
 * Picked beside the status, from the workspaces the person is in, personal
 * first as the rail lists them, and let go by picking "All workspaces".
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { Layers } from "lucide-react";

import {
  orderWorkspaces,
  workspaceLabel,
  WorkspaceFace,
  type Viewer,
} from "../../OrganizationSwitcher";
import { FilterSelect } from "./FilterSelect";

const ALL = "all";

export function WorkspaceFilter({
  organizations,
  viewer,
  selected,
  onSelect,
}: {
  organizations: MembershipDto[];
  viewer: Viewer;
  /** The handle of the workspace the list is narrowed to; undefined for all. */
  selected: string | undefined;
  onSelect: (workspace: string | undefined) => void;
}) {
  const chosen =
    selected === undefined
      ? undefined
      : organizations.find(
          ({ slug }) => slug.toLowerCase() === selected.toLowerCase(),
        );
  // A handle the person is not in is kept as written, so the × clears it
  // and the trigger says what the address asked for.
  const value = selected === undefined ? ALL : (chosen?.slug ?? selected);
  return (
    <FilterSelect
      data-testid="workspace-filter"
      label="Workspace"
      searchPlaceholder="Search workspaces…"
      value={value}
      onValueChange={(next) => onSelect(next === ALL ? undefined : next)}
      options={[
        {
          value: ALL,
          label: "All workspaces",
          icon: <Layers aria-hidden="true" className="size-3.5" />,
        },
        ...orderWorkspaces(organizations).map((organization) => ({
          value: organization.slug,
          label: workspaceLabel(organization),
          keywords: [organization.name, organization.slug],
          icon: (
            <WorkspaceFace
              organization={organization}
              viewer={viewer}
              className="size-4"
              squareRadius="rounded-[3px]"
            />
          ),
          detail: `@${organization.slug}`,
        })),
      ]}
      icon={
        chosen === undefined ? (
          <Layers aria-hidden="true" className="size-3.5" />
        ) : (
          <WorkspaceFace
            organization={chosen}
            viewer={viewer}
            className="size-4"
            squareRadius="rounded-[3px]"
          />
        )
      }
      text={
        selected === undefined
          ? "All workspaces"
          : chosen === undefined
            ? `@${selected}`
            : workspaceLabel(chosen)
      }
      onClear={selected === undefined ? undefined : () => onSelect(undefined)}
      clearLabel="Show every workspace"
    />
  );
}
