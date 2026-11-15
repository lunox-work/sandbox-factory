/**
 * Which platform the extension talks to, and the key its token is stored
 * under. One origin serves the web app and its API (`/api/v1/…`), so the
 * tokens page and the requests share it.
 *
 * The address is a user or application setting. A repository's
 * `.vscode/settings.json` must not redirect authenticated requests, so a
 * workspace-level value is ignored, and the stored token is bound to the
 * origin it was pasted for: changing the address never sends an old token
 * to a new host.
 */

import { CONTRIBUTOR_TOKEN_PREFIX } from "sandbox-factory";

export interface SettingInspection<T> {
  readonly defaultValue?: T | undefined;
  readonly globalValue?: T | undefined;
  readonly workspaceValue?: T | undefined;
  readonly workspaceFolderValue?: T | undefined;
}

export const DEFAULT_PLATFORM_ORIGIN = "https://platform.lunox.work";

export interface ResolvedOrigin {
  readonly origin: string;
  /** A workspace or folder tried to set the address and was ignored. */
  readonly overrideIgnored: boolean;
  /** The configured value was not an absolute http(s) URL; the default is used. */
  readonly invalid: boolean;
}

export function resolvePlatformOrigin(
  inspection: SettingInspection<string> | undefined,
): ResolvedOrigin {
  const overrideIgnored =
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined;
  const configured =
    inspection?.globalValue ??
    inspection?.defaultValue ??
    DEFAULT_PLATFORM_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("scheme");
    return { origin: url.origin, overrideIgnored, invalid: false };
  } catch {
    return { origin: DEFAULT_PLATFORM_ORIGIN, overrideIgnored, invalid: true };
  }
}

export function tokenKeyFor(origin: string): string {
  return `sandboxFactory.token:${origin}`;
}

/** The web page where a person makes a contributor token. */
export function tokensPageUrl(origin: string): string {
  return `${origin}/contributions#contributor-tokens`;
}

/** Why a pasted value is not a contributor token; null when it looks like one. */
export function tokenProblem(token: string): string | null {
  if (token.startsWith(CONTRIBUTOR_TOKEN_PREFIX)) return null;
  return `That is not a contributor token: one starts with ${CONTRIBUTOR_TOKEN_PREFIX}. Make one on your Contributions page, under Tokens for your editor or agent.`;
}
