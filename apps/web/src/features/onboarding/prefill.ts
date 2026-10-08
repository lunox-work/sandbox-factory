/**
 * A new bounty started from somewhere that already knows what it is about:
 * home's repository x-ray, which knows the repository and the module.
 *
 * Carried in the new-bounty page's address rather than in memory, so the
 * page reads the same after a reload, and a link to it can be shared. Only
 * ids and a path travel; the page checks the repository against the
 * workspace's own list before it uses it.
 */

import { NEW_BOUNTY_PATH } from "../../routes";

/** What a bounty written from here starts with. */
export interface BountyPrefill {
  repoId: string;
  /** The module it is about, when one was picked. */
  area?: string | undefined;
}

export function newBountyUrl(prefill?: BountyPrefill): string {
  if (prefill === undefined) return NEW_BOUNTY_PATH;
  const params = new URLSearchParams({ repo: prefill.repoId });
  if (prefill.area !== undefined) params.set("area", prefill.area);
  return `${NEW_BOUNTY_PATH}?${params.toString()}`;
}

export function prefillFromSearch(search: string): BountyPrefill | null {
  const params = new URLSearchParams(search);
  const repoId = params.get("repo");
  if (repoId === null || repoId === "") return null;
  const area = params.get("area");
  return {
    repoId,
    ...(area === null || area === "" ? {} : { area }),
  };
}

/**
 * The description a bounty about one module starts with: a sentence for the
 * person to finish, naming where the work is.
 */
export function areaDescription(area: string | undefined): string {
  return area === undefined ? "" : `In \`${area}\`, `;
}
