/**
 * Secrets: the credentials a source repository can hold in its text (a
 * private key, a cloud or API token, a password assigned in code) and the
 * files that exist to hold them (`.env`, `*.pem`, a service-account JSON).
 *
 * A sandbox is cut from a private repository, so a slice that reaches a
 * secret-named file is refused, and a build scans every public file it
 * generates and blocks on what it finds. A finding names its rule, file and
 * line, never the value: a blocker is shown to the people and agents the
 * value must not reach.
 *
 * Provider rules match a token's own shape. The generic rule needs a
 * secret-like name assigned a long literal of high entropy with letters and
 * digits, and skips obvious placeholders (`xxx`, `changeme`, `<token>`,
 * `example`, `${VAR}`); an environment read is not a literal, so it never
 * matches, but its fallback (`process.env.API_KEY ?? "…"`) is. A hex value
 * under a name that says it is a hash (`tokenHash`, `secretDigest`) is a
 * digest, not a credential. A URL's password (`postgres://app:…@db`) counts
 * unless it is empty, a template or a placeholder word (`user:password@`).
 */

import type { ProjectBlocker } from "./project.js";

export const SECRET_RULES = [
  "private-key",
  "aws-access-key-id",
  "github-token",
  "gitlab-token",
  "npm-token",
  "slack-token",
  "stripe-live-key",
  "google-api-key",
  "google-service-account",
  "jwt",
  "anthropic-key",
  "openai-key",
  "url-credentials",
  "generic-secret",
] as const;
export type SecretRule = (typeof SECRET_RULES)[number];

export interface SecretFinding {
  readonly rule: SecretRule;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
}

/** Findings a blocker's detail names before it counts the rest. */
const FINDINGS_SHOWN = 5;
/** Shortest literal the generic rule considers. */
const GENERIC_MIN_LENGTH = 16;
/** Bits per character below which a literal reads as words, not a key. */
const GENERIC_MIN_ENTROPY = 3.5;

/** Words that make a match documentation or a fixture, not a credential. */
const PLACEHOLDER =
  /example|sample|placeholder|changeme|change_me|dummy|fake|fixture|mock|redacted|your|xxxx|\*\*\*|<|>|\$\{|\{\{|test|sandbox|todo|insert|replace/i;

/** Rules that match a provider's token shape anywhere in the text. */
const TOKEN_RULES: readonly { rule: SecretRule; pattern: RegExp }[] = [
  { rule: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    rule: "github-token",
    pattern: /\b(?:gh[opsur]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})\b/g,
  },
  { rule: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { rule: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { rule: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { rule: "stripe-live-key", pattern: /\b[rs]k_live_[A-Za-z0-9]{10,}/g },
  { rule: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  {
    rule: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  { rule: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    rule: "openai-key",
    pattern:
      /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{48}\b)/g,
  },
];

/** A PEM header; the block counts only with a base64 body after it. */
const PRIVATE_KEY_HEADER =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_BODY = /[A-Za-z0-9+/]{40,}/;

const SECRET_NAME =
  "[\\w.$-]*?(?:password|passwd|secret|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key)\\w*";
/**
 * `name = "value"`, `name: 'value'`, `"name": "value"`, and typed,
 * `name: string = "value"`, anywhere on a line.
 */
const QUOTED_ASSIGNMENT = new RegExp(
  `(${SECRET_NAME})["']?(?:\\s*:\\s*[A-Za-z_$][\\w$.<>\\[\\]]*)?\\s*(?::=|=>|[:=])\\s*(["'\`])([^"'\`\\n]+)\\2`,
  "gi",
);
/**
 * `NAME=value` or `name: value` alone on a line, as env and YAML files have
 * it, a trailing `# comment` aside.
 */
const BARE_ASSIGNMENT = new RegExp(
  `^[ \\t]*(?:export[ \\t]+|-[ \\t]+)?(${SECRET_NAME})[ \\t]*[:=][ \\t]*([^\\s"'\`#]+)[ \\t]*(?:#.*)?$`,
  "gim",
);
/** A literal a secret-named read falls back to: `env.API_KEY ?? "value"`. */
const FALLBACK_ASSIGNMENT = new RegExp(
  `(${SECRET_NAME})[^"'\`\\n]*?(?:\\?\\?|\\|\\|)\\s*(["'\`])([^"'\`\\n]+)\\2`,
  "gi",
);
/** A name word that says its value is a digest of something, not the thing. */
const DIGEST_WORD =
  /^(?:hash|hashed|digest|checksum|integrity|fingerprint|sha\d*)$/;
const HEX_DIGEST = /^(?:sha\d+[:-])?[0-9a-f]+$/i;

/** `scheme://user:password@host`; the user may be empty, the password not. */
const URL_CREDENTIALS =
  /\b[a-z][a-z0-9+.-]*:\/\/([^\s:/@"'`]*):([^\s/@"'`]+)@[\w[]/gi;
/** Passwords that stand for one in documentation and local defaults. */
const URL_PASSWORD_PLACEHOLDER =
  /^(?:pass(?:word)?|passwd|pwd|pw|secret|admin|root|guest|user(?:name)?|postgres|mysql|redis|token|[x*.]+)$/i;

/** Shannon entropy of a string, in bits per character. */
export function entropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Whether a name's words (`tokenHash`, `TOKEN_SHA256`) say it holds a digest. */
function digestName(name: string): boolean {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .some((word) => DIGEST_WORD.test(word));
}

/** Whether a literal assigned to `name` looks like a generated credential. */
function secretLike(name: string, value: string): boolean {
  return (
    value.length >= GENERIC_MIN_LENGTH &&
    !(HEX_DIGEST.test(value) && digestName(name)) &&
    !/\s|:\/\//.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !PLACEHOLDER.test(value) &&
    entropy(value) >= GENERIC_MIN_ENTROPY
  );
}

/** Whether a URL's password is one, not a template or placeholder. */
function urlPasswordLike(user: string, password: string): boolean {
  return (
    password !== user &&
    !/[$%{}<>]/.test(password) &&
    !URL_PASSWORD_PLACEHOLDER.test(password) &&
    !PLACEHOLDER.test(password)
  );
}

/** Each secret found in each file's text, by file, line and rule. */
export function scanSecrets(
  files: readonly { readonly path: string; readonly text: string }[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const { text } = file;
    const starts = [0];
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
      starts.push(i + 1);
    const lineAt = (index: number) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((starts[mid] ?? 0) <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    };
    const seen = new Set<string>();
    const found = (rule: SecretRule, index: number) => {
      const line = lineAt(index);
      const key = `${rule}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ rule, file: file.path, line });
    };
    for (const match of text.matchAll(PRIVATE_KEY_HEADER)) {
      const after = text
        .slice(match.index + match[0].length, match.index + 400)
        .replace(/\\n|\s/g, "");
      if (KEY_BODY.test(after)) found("private-key", match.index);
    }
    for (const { rule, pattern } of TOKEN_RULES)
      for (const match of text.matchAll(pattern))
        if (!PLACEHOLDER.test(match[0])) found(rule, match.index);
    const serviceKey = /"private_key"\s*:\s*"[^"]{20,}/.exec(text);
    if (serviceKey !== null && /"client_email"\s*:/.test(text))
      found("google-service-account", serviceKey.index);
    for (const match of text.matchAll(URL_CREDENTIALS))
      if (urlPasswordLike(match[1] ?? "", match[2] ?? ""))
        found("url-credentials", match.index);
    for (const pattern of [QUOTED_ASSIGNMENT, FALLBACK_ASSIGNMENT])
      for (const match of text.matchAll(pattern))
        if (secretLike(match[1] ?? "", match[3] ?? ""))
          found("generic-secret", match.index);
    for (const match of text.matchAll(BARE_ASSIGNMENT))
      if (secretLike(match[1] ?? "", match[2] ?? ""))
        found("generic-secret", match.index);
  }
  return findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      SECRET_RULES.indexOf(a.rule) - SECRET_RULES.indexOf(b.rule),
  );
}

/**
 * Files that exist to hold credentials: environment files, keys and
 * keystores, SSH identities, credential, service-account and admin SDK
 * JSON, AWS shared credentials, and npm and netrc configuration (which
 * carry registry and host tokens). Matched on the basename,
 * case-insensitively, except `.aws/credentials`, a path suffix. An
 * environment template (`.env.example`, `.env.local.sample`) documents
 * keys, not values, so it is not one; its text is scanned like any other.
 * No slice may include one, and no agent tool reads one.
 */
export function isSecretPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  return (
    ((name === ".env" || name.startsWith(".env.")) &&
      !/\.(?:example|sample|template)$/.test(name)) ||
    name === ".npmrc" ||
    name === ".netrc" ||
    name === "_netrc" ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name) ||
    /(?:credentials|service[-_]account|adminsdk).*\.json$/.test(name) ||
    lower === ".aws/credentials" ||
    lower.endsWith("/.aws/credentials")
  );
}

/** A blocker for each file with findings, naming lines and rules, never values. */
export function secretBlockers(
  findings: readonly SecretFinding[],
): ProjectBlocker[] {
  const byFile = new Map<string, SecretFinding[]>();
  for (const finding of findings)
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  return [...byFile.entries()].map(([file, list]) => {
    const shown = list
      .slice(0, FINDINGS_SHOWN)
      .map((finding) => `${file}:${finding.line} (${finding.rule})`)
      .join(", ");
    const rest = list.length - FINDINGS_SHOWN;
    return {
      code: "secret_found",
      file,
      detail: `A credential appears at ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Remove it or replace it with a fixture value.`,
    };
  });
}
