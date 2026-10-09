/**
 * Sections that a button elsewhere on the page scrolls to: "pick a
 * repository" in the checklist.
 *
 * Found by element id rather than by test id, so what the page does never
 * hangs on markup that exists for the tests. Each is on screen at most once.
 */
export const SECTION = {
  backlogScan: "backlog-scan",
  repoPicker: "repo-picker",
} as const;

export type SectionId = (typeof SECTION)[keyof typeof SECTION];

/** Scrolls a section into view, where it is on the page and the browser can. */
export function reveal(
  id: SectionId,
  block: ScrollLogicalPosition = "start",
): void {
  document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block });
}
