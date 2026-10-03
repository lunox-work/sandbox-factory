/** Held roles may be combined; assignment inputs remain single roles. */
export const ORGANIZATION_ROLE_VALUES = ["owner", "admin", "member"] as const;
export type HeldOrganizationRole = (typeof ORGANIZATION_ROLE_VALUES)[number];

export function parseHeldRoles(value: string): HeldOrganizationRole[] {
  return value.split(",").flatMap((entry) => {
    const role = entry.trim();
    return ORGANIZATION_ROLE_VALUES.filter((known) => known === role);
  });
}

const ranks: Record<HeldOrganizationRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};
export function rankAtLeast(
  held: string,
  required: HeldOrganizationRole,
): boolean {
  return parseHeldRoles(held).some((role) => ranks[role] >= ranks[required]);
}
