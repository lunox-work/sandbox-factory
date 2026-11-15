/**
 * Disclosure beyond the vocabulary: the text in a public file that says
 * whose code a sandbox was cut from although it names none of the
 * workspace's configured names (`vocabulary.ts`). An outside contributor
 * reads every public file, and copied source keeps its comments.
 *
 * The scan finds, deterministically and without the network: email
 * addresses, URLs and bare hostnames, IPv4 addresses, copyright lines that
 * name an owner, `@author` and `Author:` tags (and a JSON `"author"`), issue
 * keys of the workspace's Jira projects (`PAY-123`, keys given by the
 * caller), Slack, Teams and Discord links and `#team-channel` mentions, and
 * the name in `TODO(name)` / `FIXME(name)` / `TODO @name`.
 *
 * What is public is not a finding: the reserved names (`example.com`,
 * `.test`, `.invalid`, `.example`, `localhost`, a single-label service name
 * such as `http://db:5432`), loopback and documentation addresses, and a
 * short list of public hosts a project's files point at by nature (the npm
 * registry, nodejs.org, typescriptlang.org, github.com, the web standards'
 * and licences' sites). Neither is text the version's name table wrote
 * (`publicNames`, its rules' `after`): a pseudonym is the sanctioned
 * public name, so an address renamed to `ops@example.com` or a host to
 * `api.northwind.test` passes. In TypeScript and JavaScript a bare
 * hostname, a `#channel` and a `TODO(name)` count only inside a comment or a
 * string literal (`commentAndStringRanges`), so `req.user.org` is code, not
 * a host; data and prose files are read whole.
 *
 * Every finding carries its `value` (what an owner acknowledges, kind and
 * value together: `DisclosureAcknowledgement`) and its `term` (the text a
 * pseudonym `text` rule would rename: an address's domain, a URL's host, a
 * tag's name). Findings are the workspace's own text, shown to its owners
 * and admins and to the pseudonyms agent, never to a contributor.
 */

import type { ProjectBlocker } from "./project.js";

export const DISCLOSURE_KINDS = [
  "email",
  "url",
  "host",
  "ip",
  "copyright",
  "author",
  "ticket",
  "chat",
  "todo_name",
] as const;
export type DisclosureKind = (typeof DISCLOSURE_KINDS)[number];

export interface DisclosureFinding {
  readonly kind: DisclosureKind;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** The text found, normalised as an acknowledgement names it. */
  readonly value: string;
  /** What a pseudonym `text` rule would rename to hide it. */
  readonly term: string;
}

/**
 * An owner's word that a finding may be public ("a public SaaS docs
 * link"), kept on the version's draft. A sliced draft's list is in its
 * transform, so a changed list is a different build: its build redacts the
 * generated prose and stub comments by it and shows the pseudonyms agent
 * what it leaves. An uploaded or generated draft's build reads none, so
 * its files never depend on the list, and publication checks the list
 * against the findings its build recorded (`openDisclosureFindings`).
 * Matches a finding of the same kind and value;
 * a `host` acknowledgement also covers every URL, address and chat link on
 * that host or under it.
 */
export interface DisclosureAcknowledgement {
  readonly kind: DisclosureKind;
  readonly value: string;
  readonly note?: string | null;
  /** Who acknowledged it, and when; set by the API. */
  readonly by?: string | null;
  readonly at?: string | null;
}

export interface DisclosureContext {
  /** The workspace's Jira project keys (`PAY`): `PAY-123` is a finding. */
  readonly ticketKeys?: readonly string[];
  /** Text the version's name table wrote (its rules' `after`). */
  readonly publicNames?: readonly string[];
  /** More hosts to treat as public, beside `PUBLIC_HOSTS`. */
  readonly publicHosts?: readonly string[];
}

/**
 * A recorded finding, as the build manifest's disclosure gate keeps it.
 * Its stable identity is its kind and value (what an acknowledgement
 * names); `file` and `line` say where. `acknowledged` is what the build
 * read: always false in a gate acknowledged at publication.
 */
export interface DisclosureFindingRecord extends DisclosureFinding {
  readonly acknowledged: boolean;
}

/** Findings a gate records; the count beyond is kept as `total`. */
export const DISCLOSURE_FINDINGS_RECORDED = 200;
/**
 * Findings a gate acknowledged at publication records: every one, up to
 * this many, since publication can only clear what the build recorded.
 * Any beyond it hold the version until the folder is cut again.
 */
export const DISCLOSURE_FINDINGS_EVALUATED = 1000;
/** Acknowledgements a draft may hold. */
export const DISCLOSURE_ACKNOWLEDGEMENTS_MAX = 200;
/** Findings a blocker's detail names before it counts the rest. */
const FINDINGS_SHOWN = 5;

/**
 * Hosts whose links are public by nature: the registry and toolchain a
 * project names, code hosting, and the standards' and licences' sites a
 * header or a doc comment points at. A subdomain counts as its host.
 */
export const PUBLIC_HOSTS: readonly string[] = [
  "npmjs.org",
  "npmjs.com",
  "yarnpkg.com",
  "nodejs.org",
  "typescriptlang.org",
  "github.com",
  "githubusercontent.com",
  "developer.mozilla.org",
  "w3.org",
  "whatwg.org",
  "ietf.org",
  "rfc-editor.org",
  "tc39.es",
  "ecma-international.org",
  "json-schema.org",
  "schemastore.org",
  "semver.org",
  "spdx.org",
  "opensource.org",
  "apache.org",
  "gnu.org",
  "creativecommons.org",
  "unicode.org",
  "iana.org",
];
/** Reserved for documentation and testing (RFC 2606, RFC 6761). */
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
const RESERVED_TLDS = ["example", "test", "invalid", "localhost"];
/** Chat products whose links name a workspace, a channel or a person. */
const CHAT_HOSTS = [
  "slack.com",
  "teams.microsoft.com",
  "teams.live.com",
  "discord.com",
  "discord.gg",
];

/**
 * Top-level labels a bare hostname is read under, and how many labels it
 * needs: `acme.com` is a host, but `socket.io` is a package and `user.id`
 * a property, so the ambiguous ones need three (`api.acme.io`) and the
 * rest are never read bare (a URL or an address still finds them).
 */
const BARE_TLDS: ReadonlyMap<string, number> = new Map([
  ...["com", "net", "org", "internal", "corp", "lan", "intranet"].map(
    (tld) => [tld, 2] as const,
  ),
  ...["local", "localdomain", "private", "io", "co", "cloud"].map(
    (tld) => [tld, 3] as const,
  ),
  ...["biz", "info", "tech", "xyz", "uk", "sg", "au", "de", "nl", "jp"].map(
    (tld) => [tld, 3] as const,
  ),
]);

const URL_PATTERN = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'`<>()[\]{}\\|^]+)/gi;
const EMAIL_PATTERN =
  /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,24})(?![\w-])/g;
const HOST_PATTERN =
  /(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(?![\w-]|\.\w|\()/g;
const IP_PATTERN =
  /(?<![\w.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\w]|\.\d)/g;
const COPYRIGHT_PATTERN =
  /(?:\bcopyright\b|SPDX-FileCopyrightText:|(?=©))[ \t]*((?:\(c\)|©)?)[ \t]*((?:(?:19|20)\d{2}(?:[ \t]*[-–,][ \t]*(?:(?:19|20)\d{2}|present))*)?)[ \t]*,?[ \t]*(?:by[ \t]+)?([^\n]*)/gi;
const AUTHOR_TAG = /@author[ \t]+([^\s][^\n]*)/g;
const AUTHOR_LINE =
  /^[ \t]*(?:\/\/+|\/?\*+|#+|--|;+)[ \t]*(?:authors?|maintainers?|written by)[ \t]*:[ \t]*([^\s][^\n]*)$/gim;
const AUTHOR_PROSE =
  /^[ \t]*(?:authors?|maintainers?|written by)[ \t]*:[ \t]*([^\s][^\n]*)$/gim;
const AUTHOR_JSON = /"(?:author|maintainer)s?"[ \t]*:[ \t]*"([^"\n]+)"/g;
const CHANNEL_PATTERN =
  /(?<=^|[ \t])#([a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)+)(?![\w-])/gm;
const TODO_PAREN =
  /\b(?:TODO|FIXME|XXX|HACK|BUG|NOTE)[ \t]*\(([^)\n]{1,60})\)/g;
const TODO_AT = /\b(?:TODO|FIXME|XXX|HACK)\b[ \t:]*@([A-Za-z][\w.-]{1,39})/g;
/**
 * Tags a `TODO(...)` takes that are a topic, not a person: `TODO(perf)`.
 */
const TODO_TOPICS =
  /^(?:perf|performance|cleanup|clean-up|refactor|security|types?|tests?|docs?|i18n|l10n|a11y|later|someday|v\d+|deprecat\w*|migration|compat\w*|hack|temp|wip|bug|fix|optional|future|followup|follow-up)$/i;
/** A name's stand-in: a template, a placeholder word, no name at all. */
const PLACEHOLDER_NAME =
  /^(?:<[^>]*>|\[[^\]]*\]|\{[^}]*\}|\$\{[^}]*\}|the authors?|(?:the )?contributors|(?:copyright )?(?:owner|holder)s?|your name|name|yyyy\b.*|year\b.*|notice\b.*|string|number|unknown|any|null|undefined)$/i;

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Prose a channel or a `TODO(name)` is read in whole. */
const PROSE_FILE = /\.(?:md|markdown|mdx|txt|rst|adoc)$|(?:^|\/)[A-Z]+$/;

const lower = (text: string) => text.toLowerCase();

/** Whether `host` is `domain` or under it. */
function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Whether a host is public by nature or reserved, or a single label. */
export function publicHost(
  host: string,
  extra: readonly string[] = [],
): boolean {
  const name = lower(host).replace(/\.$/, "");
  if (!name.includes(".")) return true;
  if (/^[\d.]+$/.test(name)) return publicIp(name);
  const tld = name.slice(name.lastIndexOf(".") + 1);
  return (
    RESERVED_TLDS.includes(tld) ||
    [...RESERVED_DOMAINS, ...PUBLIC_HOSTS, ...extra.map(lower)].some((domain) =>
      under(name, domain),
    )
  );
}

/**
 * Loopback, unspecified, broadcast and the three documentation ranges
 * (RFC 5737): an address that names no one's machine.
 */
function publicIp(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 127 ||
    ip === "0.0.0.0" ||
    ip === "255.255.255.255" ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** A Jira project key: two to ten capitals, digits or `_`, a capital first. */
const TICKET_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

export interface TextRange {
  readonly start: number;
  readonly end: number;
  readonly type: "comment" | "string";
}

/**
 * Where a TypeScript or JavaScript file's comments and string literals are
 * (template literals whole, their `${}` included). A light lexer, not a
 * parser: a `/` reads as a regular expression after an operator, an
 * opening bracket, a keyword that takes an expression, or at the start,
 * and as division otherwise, which is right for the code a slice holds.
 */
export function commentAndStringRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  let index = 0;
  let previous = "";
  const length = text.length;
  while (index < length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? length : end;
      ranges.push({ start: index, end: stop, type: "comment" });
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      ranges.push({ start: index, end: stop, type: "comment" });
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let at = index + 1;
      let depth = 0;
      while (at < length) {
        const inner = text[at];
        if (inner === "\\") at += 2;
        else if (char === "`" && inner === "$" && text[at + 1] === "{") {
          depth += 1;
          at += 2;
        } else if (char === "`" && depth > 0 && inner === "}") {
          depth -= 1;
          at += 1;
        } else if (inner === char && depth === 0) break;
        else if (inner === "\n" && char !== "`") break;
        else at += 1;
      }
      const stop = Math.min(at + 1, length);
      ranges.push({ start: index, end: stop, type: "string" });
      index = stop;
      previous = char;
      continue;
    }
    if (char === "/" && regexMayStart(previous, text, index)) {
      let at = index + 1;
      let inClass = false;
      while (at < length) {
        const inner = text[at];
        if (inner === "\\") at += 2;
        else if (inner === "\n") break;
        else if (inner === "[") ((inClass = true), (at += 1));
        else if (inner === "]") ((inClass = false), (at += 1));
        else if (inner === "/" && !inClass) break;
        else at += 1;
      }
      index = at + 1;
      previous = "/";
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return ranges;
}

const EXPRESSION_KEYWORD =
  /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function regexMayStart(previous: string, text: string, index: number): boolean {
  if (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous)) return true;
  return EXPRESSION_KEYWORD.test(text.slice(Math.max(0, index - 12), index));
}

/** 1-based line of an offset, from the offsets lines start at. */
function lineFinder(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
    starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** A URL's host, from what follows `scheme://`: no user, port or path. */
function hostOf(rest: string): string {
  const authority = rest.split(/[/?#]/, 1)[0] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  return lower(host.startsWith("[") ? host : host.replace(/:\d*$/, ""));
}

/** What closes a sentence after a URL; a block comment's close is checked too. */
const URL_TAIL = new Set("*.,;:!?'\")]}>");

/**
 * A URL without what closes the sentence or comment it ends. A loop from
 * the end, not a `(…)+$` pattern: the input is uploaded text, and an
 * anchored repetition backtracks on long runs of `*` or `!`.
 */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    if (url.endsWith("*/", end)) end -= 2;
    else if (URL_TAIL.has(url[end - 1] ?? "")) end -= 1;
    else break;
  }
  return url.slice(0, end);
}

/** `text` up to the first `marker`, all of it without one. */
function cutAt(text: string, marker: string): string {
  const at = text.indexOf(marker);
  return at === -1 ? text : text.slice(0, at);
}

/** Characters trimmed from both ends of a name once its spaces collapse. */
const NAME_EDGE = new Set(" ,;:.*-");

/**
 * A name, cut where its comment or line ends, spaces collapsed. Cuts and
 * trims are index scans rather than `.*$` / `[…]+$` patterns, which run
 * in quadratic time on uploaded text.
 */
function cleanName(raw: string): string {
  let name = cutAt(cutAt(cutAt(raw, "*/"), "-->"), "--!>");
  const rights = name.search(/\ball rights reserved\b/i);
  if (rights !== -1) name = name.slice(0, rights);
  name = name.replace(/\s+/g, " ");
  let start = 0;
  let end = name.length;
  while (start < end && NAME_EDGE.has(name[start] ?? "")) start += 1;
  while (end > start && NAME_EDGE.has(name[end - 1] ?? "")) end -= 1;
  return name.slice(start, end);
}

/** Whether `text` holds a name, once public addresses and pseudonyms go. */
function namesSomeone(
  text: string,
  publicNames: readonly string[],
  extraHosts: readonly string[],
): boolean {
  let rest = text
    .replace(EMAIL_PATTERN, (address, domain: string) =>
      publicHost(domain, extraHosts) ? " " : address,
    )
    .replace(URL_PATTERN, (url, _scheme, tail: string) =>
      publicHost(hostOf(tail), extraHosts) ? " " : url,
    );
  for (const name of publicNames)
    if (name.length >= 2) rest = rest.split(name).join(" ");
  rest = rest.replace(/[<>()[\]{}"',.;:@|/\\-]/g, " ").trim();
  return /[A-Za-z]{2}/.test(rest) && !PLACEHOLDER_NAME.test(rest);
}

/**
 * Every finding in every file, by file, line and kind. Files are given in
 * public names, as a contributor would read them.
 */
export function scanDisclosure(
  files: readonly { readonly path: string; readonly text: string }[],
  context: DisclosureContext = {},
): DisclosureFinding[] {
  const publicNames = (context.publicNames ?? []).filter(
    (name) => name.trim().length >= 2,
  );
  const publicNamesLower = publicNames.map(lower);
  const extraHosts = context.publicHosts ?? [];
  const keys = [...new Set(context.ticketKeys ?? [])].filter((key) =>
    TICKET_KEY.test(key),
  );
  const ticketPattern =
    keys.length === 0
      ? null
      : new RegExp(
          `(?<![\\w-])((?:${keys.join("|")})-\\d{1,7})(?![\\w-])`,
          "g",
        );
  // Text a pseudonym wrote is the sanctioned public name.
  // Whole words of it: `ada` is not sanctioned by a pseudonym `Canada`.
  const sanctioned = (term: string) => {
    const wanted = lower(term);
    return publicNamesLower.some((name) => {
      for (
        let at = name.indexOf(wanted);
        at !== -1;
        at = name.indexOf(wanted, at + 1)
      )
        if (
          !/[a-z0-9]/.test(name[at - 1] ?? "") &&
          !/[a-z0-9]/.test(name[at + wanted.length] ?? "")
        )
          return true;
      return false;
    });
  };
  const findings: DisclosureFinding[] = [];
  for (const file of files) {
    const { text } = file;
    const lineAt = lineFinder(text);
    const code = CODE_FILE.test(file.path);
    const prose = PROSE_FILE.test(file.path);
    const ranges = code ? commentAndStringRanges(text) : [];
    const inRange = (index: number, types: readonly TextRange["type"][]) =>
      !code ||
      ranges.some(
        (range) =>
          types.includes(range.type) &&
          index >= range.start &&
          index < range.end,
      );
    // Spans a URL or address already covers: a host inside is not another.
    const covered: { start: number; end: number }[] = [];
    const coveredAt = (index: number) =>
      covered.some((span) => index >= span.start && index < span.end);
    const seen = new Set<string>();
    const found = (
      kind: DisclosureKind,
      index: number,
      value: string,
      term: string,
    ) => {
      if (value === "" || sanctioned(term)) return;
      const line = lineAt(index);
      const key = `${kind}\u0000${line}\u0000${value}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ kind, file: file.path, line, value, term });
    };
    for (const match of text.matchAll(URL_PATTERN)) {
      const scheme = lower(match[1] ?? "");
      const url = trimUrl(match[0]);
      covered.push({ start: match.index, end: match.index + match[0].length });
      if (scheme === "file") continue;
      const host = hostOf(url.slice(scheme.length + 3));
      if (scheme === "slack" || CHAT_HOSTS.some((chat) => under(host, chat))) {
        found("chat", match.index, url, scheme === "slack" ? url : host);
        continue;
      }
      if (host === "" || publicHost(host, extraHosts)) continue;
      found("url", match.index, url, host);
    }
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      if (coveredAt(match.index)) continue;
      covered.push({ start: match.index, end: match.index + match[0].length });
      const domain = lower(match[1] ?? "");
      if (publicHost(domain, extraHosts)) continue;
      found("email", match.index, lower(match[0]), domain);
    }
    for (const match of text.matchAll(HOST_PATTERN)) {
      if (
        coveredAt(match.index) ||
        !inRange(match.index, ["comment", "string"])
      )
        continue;
      const host = match[1] ?? "";
      const labels = host.split(".");
      const needed = BARE_TLDS.get(labels.at(-1) ?? "");
      if (needed === undefined || labels.length < needed) continue;
      if (publicHost(host, extraHosts)) continue;
      found("host", match.index, host, host);
    }
    for (const match of text.matchAll(IP_PATTERN)) {
      if (coveredAt(match.index)) continue;
      const ip = match[1] ?? "";
      if (publicIp(ip)) continue;
      found("ip", match.index, ip, ip);
    }
    for (const match of text.matchAll(COPYRIGHT_PATTERN)) {
      const marked = (match[1] ?? "") !== "" || (match[2] ?? "") !== "";
      const isSpdx = match[0].startsWith("SPDX");
      if (!marked && !isSpdx) continue;
      const owner = cleanName(match[3] ?? "");
      if (owner === "" || !namesSomeone(owner, publicNames, extraHosts))
        continue;
      found("copyright", match.index, owner, owner);
    }
    const authorPatterns = [
      AUTHOR_TAG,
      AUTHOR_LINE,
      ...(prose || /\.ya?ml$/.test(file.path) ? [AUTHOR_PROSE] : []),
      ...(file.path.endsWith(".json") ? [AUTHOR_JSON] : []),
    ];
    for (const pattern of authorPatterns)
      for (const match of text.matchAll(pattern)) {
        const name = cleanName(match[1] ?? "");
        if (name === "" || !namesSomeone(name, publicNames, extraHosts))
          continue;
        found("author", match.index, name, name);
      }
    const ticketsSeen: { start: number; end: number }[] = [];
    if (ticketPattern !== null)
      for (const match of text.matchAll(ticketPattern)) {
        const key = match[1] ?? "";
        ticketsSeen.push({ start: match.index, end: match.index + key.length });
        found("ticket", match.index, key, key);
      }
    if (code || prose)
      for (const match of text.matchAll(CHANNEL_PATTERN)) {
        if (coveredAt(match.index) || !inRange(match.index, ["comment"]))
          continue;
        const channel = `#${match[1] ?? ""}`;
        found("chat", match.index, channel, channel);
      }
    for (const pattern of [TODO_PAREN, TODO_AT])
      for (const match of text.matchAll(pattern)) {
        if (!inRange(match.index, ["comment", "string"])) continue;
        const raw = match[1] ?? "";
        const name = cleanName(raw);
        // Where the name starts: the group keeps the spaces inside `( … )`.
        const at =
          match.index +
          match[0].indexOf(raw) +
          (raw.length - raw.trimStart().length);
        if (
          name === "" ||
          !/[A-Za-z]{2}/.test(name) ||
          /^#?\d+$/.test(name) ||
          TODO_TOPICS.test(name) ||
          ticketsSeen.some((span) => at >= span.start && at < span.end) ||
          /[@/:]/.test(name) ||
          !namesSomeone(name, publicNames, extraHosts)
        )
          continue;
        found("todo_name", match.index, name, name);
      }
  }
  return findings.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      DISCLOSURE_KINDS.indexOf(a.kind) - DISCLOSURE_KINDS.indexOf(b.kind) ||
      (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
  );
}

/** The hosts a finding sits on, for a `host` acknowledgement to cover. */
const HOSTED: readonly DisclosureKind[] = ["url", "email", "host", "chat"];

/** Whether an owner's acknowledgement covers a finding. */
export function acknowledges(
  acknowledgement: Pick<DisclosureAcknowledgement, "kind" | "value">,
  finding: Pick<DisclosureFinding, "kind" | "value" | "term">,
): boolean {
  if (
    acknowledgement.kind === finding.kind &&
    acknowledgement.value === finding.value
  )
    return true;
  return (
    acknowledgement.kind === "host" &&
    HOSTED.includes(finding.kind) &&
    under(lower(finding.term), lower(acknowledgement.value))
  );
}

/** The findings no acknowledgement covers: what blocks a build. */
export function unacknowledgedFindings<
  T extends Pick<DisclosureFinding, "kind" | "value" | "term">,
>(
  findings: readonly T[],
  acknowledgements: readonly Pick<
    DisclosureAcknowledgement,
    "kind" | "value"
  >[],
): T[] {
  return findings.filter(
    (finding) =>
      !acknowledgements.some((acknowledgement) =>
        acknowledges(acknowledgement, finding),
      ),
  );
}

/**
 * What a recorded disclosure gate still holds a version on, against the
 * draft's acknowledgements as they stand: for a gate acknowledged at
 * publication (`acknowledgedAt: "publish"`, an upload's or a starter's,
 * whose build read no acknowledgement) the recorded findings no entry
 * covers, and `unrecorded`, those past the record no entry can clear; for
 * a sliced build's gate, the findings it marked unacknowledged, its
 * acknowledgements being part of its transform.
 */
export function openDisclosureFindings<
  T extends Pick<DisclosureFindingRecord, "kind" | "value" | "term"> & {
    readonly acknowledged: boolean;
  },
>(
  gate: {
    readonly acknowledgedAt?: "build" | "publish";
    readonly findings?: readonly T[];
    readonly total?: number;
  },
  acknowledgements: readonly Pick<
    DisclosureAcknowledgement,
    "kind" | "value"
  >[],
): { readonly findings: T[]; readonly unrecorded: number } {
  const recorded = gate.findings ?? [];
  if (gate.acknowledgedAt !== "publish")
    return {
      findings: recorded.filter((finding) => !finding.acknowledged),
      unrecorded: 0,
    };
  return {
    findings: unacknowledgedFindings(recorded, acknowledgements),
    unrecorded: Math.max(0, (gate.total ?? 0) - recorded.length),
  };
}

/**
 * The findings as a gate records them, the acknowledged marked, capped at
 * `limit` (`DISCLOSURE_FINDINGS_EVALUATED` for a gate acknowledged at
 * publication, which passes no acknowledgements).
 */
export function disclosureRecords(
  findings: readonly DisclosureFinding[],
  acknowledgements: readonly Pick<
    DisclosureAcknowledgement,
    "kind" | "value"
  >[],
  limit = DISCLOSURE_FINDINGS_RECORDED,
): DisclosureFindingRecord[] {
  return findings.slice(0, limit).map((finding) => ({
    ...finding,
    acknowledged: acknowledgements.some((acknowledgement) =>
      acknowledges(acknowledgement, finding),
    ),
  }));
}

/**
 * A blocker for each file with unacknowledged findings, naming lines,
 * kinds and values: shown to the workspace's owners, never to a
 * contributor.
 */
export function disclosureBlockers(
  findings: readonly DisclosureFinding[],
): ProjectBlocker[] {
  const byFile = new Map<string, DisclosureFinding[]>();
  for (const finding of findings)
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  return [...byFile.entries()].map(([file, list]) => {
    const shown = list
      .slice(0, FINDINGS_SHOWN)
      .map(
        (finding) =>
          `${file}:${finding.line} (${finding.kind} ${finding.value})`,
      )
      .join(", ");
    const rest = list.length - FINDINGS_SHOWN;
    return {
      code: "disclosure_findings",
      file,
      detail: `Text that may say whose code this is appears at ${shown}${rest > 0 ? `, and ${rest} more` : ""}. Rename it with a pseudonym text rule, or acknowledge it on the version if it may be public.`,
    };
  });
}

/**
 * The findings as hints for whoever writes the version's pseudonyms: each
 * distinct term once, with what it was found as and where first. A hint is
 * a candidate, not an instruction: a public link stays as it is.
 */
export function disclosureHints(
  findings: readonly DisclosureFinding[],
  limit = 40,
): string[] {
  const byTerm = new Map<
    string,
    { kinds: Set<string>; first: string; count: number }
  >();
  for (const finding of findings) {
    const entry = byTerm.get(finding.term) ?? {
      kinds: new Set<string>(),
      first: `${finding.file}:${finding.line}`,
      count: 0,
    };
    entry.kinds.add(finding.kind);
    entry.count += 1;
    byTerm.set(finding.term, entry);
  }
  return [...byTerm.entries()]
    .slice(0, limit)
    .map(
      ([term, entry]) =>
        `${term} (${[...entry.kinds].join(", ")}; ${entry.count === 1 ? "at" : `${entry.count} times, first at`} ${entry.first})`,
    );
}

/** What a redacted finding becomes in generated prose. */
const REDACTED: Readonly<Record<DisclosureKind, string>> = {
  email: "[email removed]",
  url: "[link removed]",
  host: "[host removed]",
  ip: "[address removed]",
  copyright: "[owner removed]",
  author: "[name removed]",
  ticket: "[ticket]",
  chat: "[chat link removed]",
  todo_name: "[name removed]",
};

/**
 * Generated text with its unacknowledged findings replaced: the bounty's
 * title, summary, spec and decisions say what the task is, never where it
 * came from, so the generated README, `TASK.md` and descriptor carry them
 * redacted by construction. Within `ranges` alone when given (a stub's
 * comments).
 */
export function redactDisclosure(
  text: string,
  context: DisclosureContext & {
    readonly acknowledgements?: readonly Pick<
      DisclosureAcknowledgement,
      "kind" | "value"
    >[];
    readonly path?: string;
    readonly ranges?: readonly { start: number; end: number }[];
  } = {},
): string {
  const path = context.path ?? "generated.md";
  const findings = unacknowledgedFindings(
    scanDisclosure([{ path, text }], context),
    context.acknowledgements ?? [],
  );
  if (findings.length === 0) return text;
  // Longest first, so a URL goes before the host inside it.
  const values = [
    ...new Map(findings.map((f) => [f.value, f.kind])).entries(),
  ].sort(([a], [b]) => b.length - a.length);
  const inRanges = (start: number, end: number) =>
    context.ranges === undefined ||
    context.ranges.some((range) => start >= range.start && end <= range.end);
  let out = "";
  let at = 0;
  while (at < text.length) {
    let replaced = false;
    for (const [value, kind] of values)
      if (text.startsWith(value, at) && inRanges(at, at + value.length)) {
        out += REDACTED[kind];
        at += value.length;
        replaced = true;
        break;
      }
    if (!replaced) {
      out += text[at] ?? "";
      at += 1;
    }
  }
  return out;
}

/**
 * A declaration stub with the findings in its comments redacted. A stub is
 * generated from the source's declarations, never edited or carried back,
 * so its doc comments may lose an author or an internal link; its types
 * are what the copied source compiles against, so text outside comments
 * (a string literal type) is left for the table or an acknowledgement.
 */
export function redactStubComments(
  path: string,
  text: string,
  context: DisclosureContext & {
    readonly acknowledgements?: readonly Pick<
      DisclosureAcknowledgement,
      "kind" | "value"
    >[];
  } = {},
): string {
  const ranges = commentAndStringRanges(text).filter(
    (range) => range.type === "comment",
  );
  if (ranges.length === 0) return text;
  return redactDisclosure(text, { ...context, path, ranges });
}
