/**
 * A new bounty started from somewhere that already knows where its work
 * is: home's repository x-ray, which knows the module and the repository
 * it is in.
 *
 * Carried in the new-bounty page's address rather than in memory, so the
 * page reads the same after a reload, and a link to it can be shared. A
 * bounty names no repository, so neither does the address: the place is
 * only the sentence its description starts with.
 */

import { NEW_BOUNTY_PATH } from "../../routes";

/** What a bounty written from here starts with. */
export interface BountyPrefill {
  /** The module the work is in. */
  area: string;
  /** The repository the module is in, by its full name. */
  repository?: string | undefined;
}

export function newBountyUrl(prefill?: BountyPrefill): string {
  if (prefill === undefined) return NEW_BOUNTY_PATH;
  const params = new URLSearchParams({ area: prefill.area });
  if (prefill.repository !== undefined) params.set("in", prefill.repository);
  return `${NEW_BOUNTY_PATH}?${params.toString()}`;
}

export function prefillFromSearch(search: string): BountyPrefill | null {
  const params = new URLSearchParams(search);
  const area = params.get("area");
  if (area === null || area === "") return null;
  const repository = params.get("in");
  return {
    area,
    ...(repository === null || repository === "" ? {} : { repository }),
  };
}

/**
 * The description a bounty about one module starts with: a sentence for the
 * person to finish, naming where the work is.
 */
export function areaDescription(prefill: BountyPrefill): string {
  return prefill.repository === undefined
    ? `In \`${prefill.area}\`, `
    : `In \`${prefill.area}\` of \`${prefill.repository}\`, `;
}
