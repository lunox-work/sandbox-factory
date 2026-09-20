/**
 * URL tidying shared by the credential and the issue mapper.
 *
 * Exists for one reason: `siteUrl.replace(/\/+$/, "")` — the obvious way to
 * write this, and what both call sites used — is a denial-of-service risk.
 * `/\/+$/` is a greedy repetition anchored at the end, so on a string of *n*
 * trailing slashes that is not followed by the end of input, the engine
 * retries the match from every position and takes O(n²). A 60,000-slash input
 * blocks the event loop for over a second; the scan below does it in zero.
 *
 * That input is not hypothetical. `siteUrl` arrives from Atlassian's
 * `accessible-resources` response and from the stored `jira_connection` row,
 * neither of which this package controls, and one blocked request in a Node
 * process blocks every other request it is serving.
 */

/**
 * Strips trailing slashes, so joining a path onto the result cannot double up.
 *
 * A plain backwards scan: linear in the number of trailing slashes, with no
 * backtracking to exploit. Do not replace it with a regular expression.
 */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) {
    end -= 1;
  }
  return url.slice(0, end);
}
