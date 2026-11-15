/**
 * What a version's build found in its public files that may say whose
 * code it is, beyond the workspace's names: addresses, internal links and
 * hosts, copyright and author lines, ticket keys, chat links and the names
 * in `TODO(name)` comments (`scanDisclosure` in core). Read from the
 * build's summary, its disclosure gate, so a member sees it only where the
 * run is theirs to read; contributors never reach this page.
 *
 * An owner or admin marks each that may be public ("a library's docs")
 * and acknowledges them together. Where the gate says (`acknowledgedAt`):
 * a sliced draft's list is part of its transform, so it is built again at
 * once, and a finding stands as that build marked it; an uploaded or
 * generated draft's build read no list, so the list is saved and checked
 * at publication, and a finding stands as the list covers it now
 * (`acknowledges`). A finding to hide is renamed with a pseudonym rule, or
 * an upload cut again, which this panel does not do.
 */

import { ApiError } from "@sandbox-factory/client";
import type { DisclosureAcknowledgementDto } from "@sandbox-factory/shared";
import { useId, useState } from "react";
import { acknowledges } from "sandbox-factory";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients } from "../../data/query";

/** One finding as the build's disclosure gate records it. */
export interface DisclosureFindingView {
  readonly kind: DisclosureAcknowledgementDto["kind"];
  readonly file: string;
  readonly line: number;
  readonly value: string;
  /** What a host entry is matched on; the value when not recorded. */
  readonly term?: string;
  /** As the build read it: never, where acknowledged at publication. */
  readonly acknowledged: boolean;
}

/** Where a gate's findings are acknowledged (`acknowledgedAt` in core). */
export type DisclosureAcknowledgedAt = "build" | "publish";

const KIND_LABELS: Record<DisclosureFindingView["kind"], string> = {
  email: "Address",
  url: "Link",
  host: "Host",
  ip: "IP address",
  copyright: "Copyright",
  author: "Author",
  ticket: "Ticket",
  chat: "Chat",
  todo_name: "Name in a TODO",
};

const keyOf = (item: { kind: string; value: string }) =>
  `${item.kind}\u0000${item.value}`;

/** Where a build summary's `disclosure` gate is acknowledged. */
export function disclosureAcknowledgedAtOf(
  meta: unknown,
): DisclosureAcknowledgedAt {
  const gate =
    typeof meta === "object" && meta !== null
      ? (meta as { disclosure?: { acknowledgedAt?: unknown } }).disclosure
      : undefined;
  return gate?.acknowledgedAt === "publish" ? "publish" : "build";
}

/** The findings a build summary's `disclosure` gate holds, if any. */
export function disclosureFindingsOf(meta: unknown): DisclosureFindingView[] {
  const gate =
    typeof meta === "object" && meta !== null
      ? (meta as { disclosure?: { findings?: unknown } }).disclosure
      : undefined;
  const findings = gate?.findings;
  if (!Array.isArray(findings)) return [];
  return findings.filter(
    (item): item is DisclosureFindingView =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as DisclosureFindingView).kind === "string" &&
      (item as DisclosureFindingView).kind in KIND_LABELS &&
      typeof (item as DisclosureFindingView).value === "string" &&
      typeof (item as DisclosureFindingView).file === "string" &&
      typeof (item as DisclosureFindingView).line === "number",
  );
}

/**
 * How many findings a gate acknowledged at publication counted past its
 * record (`total` beyond the findings it holds): no acknowledgement can
 * clear them, so they hold publication until the folder is cut again
 * (`openDisclosureFindings` in core, the API's `unrecorded`). A sliced
 * build's gate blocks on its own count, so it has none here.
 */
export function disclosureUnrecordedOf(meta: unknown): number {
  const gate =
    typeof meta === "object" && meta !== null
      ? (
          meta as {
            disclosure?: {
              acknowledgedAt?: unknown;
              findings?: unknown;
              total?: unknown;
            };
          }
        ).disclosure
      : undefined;
  if (gate?.acknowledgedAt !== "publish" || typeof gate.total !== "number")
    return 0;
  const recorded = Array.isArray(gate.findings) ? gate.findings.length : 0;
  return Math.max(0, gate.total - recorded);
}

/** What the panel and a held Publish say of findings past the record. */
export function unrecordedText(unrecorded: number): string {
  return `${unrecorded === 1 ? "1 more finding was" : `${unrecorded} more findings were`} not recorded; re-cut the folder.`;
}

/**
 * Whether a finding stands acknowledged: as its build marked it, or, at
 * publication, as the draft's list covers it now.
 */
function standsAcknowledged(
  item: DisclosureFindingView,
  acknowledgements: readonly DisclosureAcknowledgementDto[],
  atPublish: boolean,
): boolean {
  return atPublish
    ? acknowledgements.some((entry) =>
        acknowledges(entry, { ...item, term: item.term ?? item.value }),
      )
    : item.acknowledged;
}

/**
 * How many findings still hold publication as the draft stands now (the
 * API's `disclosure_failed` count): those waiting for an owner's
 * acknowledgement, and, at publication, those past the record
 * (`disclosureUnrecordedOf`), which none can clear.
 */
export function openDisclosureFindingCount(
  findings: readonly DisclosureFindingView[],
  acknowledgements: readonly DisclosureAcknowledgementDto[],
  acknowledgedAt: DisclosureAcknowledgedAt = "build",
  unrecorded = 0,
): number {
  const atPublish = acknowledgedAt === "publish";
  return (
    findings.filter(
      (item) => !standsAcknowledged(item, acknowledgements, atPublish),
    ).length + (atPublish ? unrecorded : 0)
  );
}

export function DisclosureFindings({
  id,
  organizationId,
  versionId,
  findings,
  acknowledgements,
  acknowledgedAt = "build",
  unrecorded = 0,
  canAcknowledge,
  onSaved,
}: {
  /** The panel's element id, which a held Publish links to. */
  id?: string;
  organizationId: string;
  versionId: string;
  findings: readonly DisclosureFindingView[];
  /** The draft's acknowledgements, as its source holds them. */
  acknowledgements: readonly DisclosureAcknowledgementDto[];
  /**
   * `build`: the list is in a sliced draft's transform, built again on
   * saving. `publish`: an uploaded or generated draft's, checked at
   * publication with no build again.
   */
  acknowledgedAt?: DisclosureAcknowledgedAt;
  /** Findings past the record (`disclosureUnrecordedOf`): always blocking. */
  unrecorded?: number;
  /** An owner or admin, on a draft not yet frozen. */
  canAcknowledge: boolean;
  /** After the list is put (and a sliced draft queued to build again). */
  onSaved?: () => void;
}) {
  const headingId = useId();
  const atPublish = acknowledgedAt === "publish";
  const isAcknowledged = (item: DisclosureFindingView) =>
    standsAcknowledged(item, acknowledgements, atPublish);
  const held = new Set(acknowledgements.map((item) => keyOf(item)));
  // Marked: the acknowledged ones to start with.
  const [marked, setMarked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        findings
          .filter((item) =>
            atPublish ? held.has(keyOf(item)) : isAcknowledged(item),
          )
          .map((item) => keyOf(item)),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const past = atPublish ? unrecorded : 0;
  if (findings.length === 0 && past === 0) return null;

  const listed = new Set(findings.map((item) => keyOf(item)));
  // A finding a broader entry (a host) covers stays covered here.
  const coveredElsewhere = (item: DisclosureFindingView) =>
    isAcknowledged(item) && !held.has(keyOf(item));
  const wanted = new Set(
    findings
      .filter((item) => marked.has(keyOf(item)) && !coveredElsewhere(item))
      .map((item) => keyOf(item)),
  );
  const current = new Set([...held].filter((key) => listed.has(key)));
  const changed =
    wanted.size !== current.size ||
    [...wanted].some((key) => !current.has(key));
  const blocking =
    findings.filter(
      (item) => !marked.has(keyOf(item)) && !coveredElsewhere(item),
    ).length + past;
  const counted = findings.length + past;

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      // Entries for findings not listed here (a host, an earlier build's)
      // are kept as they are.
      const kept = acknowledgements
        .filter((item) => !listed.has(keyOf(item)))
        .map(({ kind, value, note }) => ({ kind, value, note: note ?? null }));
      const added = findings
        .filter((item) => wanted.has(keyOf(item)))
        .filter(
          (item, index, all) =>
            all.findIndex((other) => keyOf(other) === keyOf(item)) === index,
        )
        .map((item) => {
          const earlier = acknowledgements.find(
            (entry) => keyOf(entry) === keyOf(item),
          );
          return {
            kind: item.kind,
            value: item.value,
            note: earlier?.note ?? null,
          };
        });
      await clients.sandbox.setDisclosureAcknowledgements(
        organizationId,
        versionId,
        [...kept, ...added],
      );
      // At publication the list is read as it stands: nothing to build.
      if (!atPublish)
        await clients.sandbox.buildSandboxVersion(organizationId, versionId);
      onSaved?.();
    } catch (failure) {
      setError(
        failure instanceof ApiError
          ? failure.message
          : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      tabIndex={-1}
      className="flex scroll-mt-4 flex-col gap-3 focus-visible:outline-none"
      data-testid="disclosure-findings"
    >
      <div className="flex flex-col gap-1">
        <h4 id={headingId} className="text-sm font-medium">
          May say whose code this is
        </h4>
        <p className="text-muted-foreground text-sm">
          {canAcknowledge
            ? atPublish
              ? "Text in the public files beyond the workspace's names. Mark what may be public and acknowledge it; the version publishes once every finding is acknowledged, with no build again. What identifies the workspace has to be renamed in a new version instead."
              : "Text in the public files beyond the workspace's names. Rename what identifies the workspace with a pseudonym; mark what may be public and acknowledge it, and the version is built again."
            : atPublish
              ? "Text in the public files beyond the workspace's names. An owner or admin acknowledges it as public before the version is published."
              : "Text in the public files beyond the workspace's names. An owner or admin renames it with a pseudonym or acknowledges it as public."}
        </p>
      </div>
      {past > 0 && (
        <p className="text-destructive text-sm" data-testid="unrecorded">
          {unrecordedText(past)}
        </p>
      )}
      <ul className="divide-border flex flex-col divide-y rounded-md border text-sm">
        {findings.map((item, index) => {
          const key = keyOf(item);
          const elsewhere = coveredElsewhere(item);
          const isMarked = elsewhere || marked.has(key);
          const label = `${KIND_LABELS[item.kind]} at ${item.file}:${item.line}`;
          return (
            <li
              key={`${key}\u0000${item.file}\u0000${item.line}\u0000${index}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
                  <span className="text-foreground font-medium">
                    {KIND_LABELS[item.kind]}
                  </span>
                  <span className="font-mono">
                    {item.file}:{item.line}
                  </span>
                </span>
                <code className="font-mono text-xs break-all">
                  {item.value}
                </code>
              </div>
              {canAcknowledge && !elsewhere ? (
                <label className="flex items-center gap-2 text-xs whitespace-nowrap">
                  <input
                    type="checkbox"
                    className="accent-foreground size-4"
                    checked={isMarked}
                    disabled={busy}
                    aria-label={`${label} may be public`}
                    onChange={(event) => {
                      const next = new Set(marked);
                      if (event.target.checked) next.add(key);
                      else next.delete(key);
                      setMarked(next);
                    }}
                  />
                  May be public
                </label>
              ) : (
                <span
                  className={cn(
                    "text-xs whitespace-nowrap",
                    isMarked ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {isMarked
                    ? "Acknowledged"
                    : atPublish
                      ? "Not acknowledged"
                      : "Blocking"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs tabular-nums" role="status">
          {blocking === 0
            ? atPublish
              ? "All acknowledged."
              : "None blocking."
            : atPublish
              ? `${blocking} of ${counted} to acknowledge before publishing.`
              : `${blocking} of ${counted} blocking.`}
        </p>
        {canAcknowledge && (
          <Button
            type="button"
            size="sm"
            disabled={busy || !changed}
            onClick={() => void acknowledge()}
          >
            {atPublish
              ? busy
                ? "Saving…"
                : "Acknowledge"
              : busy
                ? "Building again…"
                : "Acknowledge and build again"}
          </Button>
        )}
      </div>
      {error !== null && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
