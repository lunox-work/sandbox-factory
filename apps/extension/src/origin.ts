/**
 * Which API the extension talks to, and the key its token is stored under.
 *
 * The API address is a user or application setting. A repository's
 * `.vscode/settings.json` must not redirect authenticated requests, so a
 * workspace-level value is ignored, and the stored token is bound to the
 * origin it was pasted for: changing the address never sends an old token
 * to a new host.
 */

export interface SettingInspection<T> {
  readonly defaultValue?: T | undefined;
  readonly globalValue?: T | undefined;
  readonly workspaceValue?: T | undefined;
  readonly workspaceFolderValue?: T | undefined;
}

export const DEFAULT_API_ORIGIN = "http://localhost:4000";

export interface ResolvedOrigin {
  readonly origin: string;
  /** A workspace or folder tried to set the address and was ignored. */
  readonly overrideIgnored: boolean;
  /** The configured value was not an absolute http(s) URL; the default is used. */
  readonly invalid: boolean;
}

export function resolveApiOrigin(
  inspection: SettingInspection<string> | undefined,
): ResolvedOrigin {
  const overrideIgnored =
    inspection?.workspaceValue !== undefined ||
    inspection?.workspaceFolderValue !== undefined;
  const configured =
    inspection?.globalValue ?? inspection?.defaultValue ?? DEFAULT_API_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("scheme");
    return { origin: url.origin, overrideIgnored, invalid: false };
  } catch {
    return { origin: DEFAULT_API_ORIGIN, overrideIgnored, invalid: true };
  }
}

export function tokenKeyFor(origin: string): string {
  return `sandboxFactory.token:${origin}`;
}
