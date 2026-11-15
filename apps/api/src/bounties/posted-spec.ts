/**
 * A spec posted with its bounty (`POST …/bounties` with `spec`), read with
 * duediligence's own parser (`duediligence/api`, pinned): `scenarios` keys
 * each scenario as the person's local tests do and `decisionItems` reads
 * the `Decided:` list they confirmed, so the platform stores the decisions
 * a person read, word for word. Core maps what was read onto a stored spec
 * and says what does not fit (`specFromDocument`).
 */

import type {
  DecisionConfirmationCredential,
  NewPostedSpec,
} from "@sandbox-factory/db";
import type {
  CreateBountyInput,
  PostedSpecInput,
} from "@sandbox-factory/shared";
import { decisionItems, scenarios } from "duediligence/api";
import { createRequire } from "node:module";
import {
  BOUNTY_SPEC_HASH_VERSION,
  bountySpecHash,
  documentBackground,
  documentFeature,
  documentOpenQuestions,
  specFromDocument,
  type PostedSpecResult,
} from "sandbox-factory";

/** The duediligence the parser is, as installed: pinned in package.json. */
export const DUEDILIGENCE_VERSION = (
  createRequire(import.meta.url)("duediligence/package.json") as {
    version: string;
  }
).version;

/** A posted document as a stored spec, or every problem with it. */
export function readPostedSpec(document: string): PostedSpecResult {
  return specFromDocument({
    feature: documentFeature(document),
    background: documentBackground(document),
    scenarios: scenarios(document),
    decisions: decisionItems(document),
    openQuestions: documentOpenQuestions(document),
  });
}

/**
 * Where a posted spec came from: the engine version the poster named, or
 * the parser's own when they named none.
 */
export function postedSpecSource(spec: PostedSpecInput): string {
  return `duediligence@${spec.engine?.version ?? DUEDILIGENCE_VERSION}`;
}

/**
 * The bounty a create with `spec` writes: its description the document when
 * none was given, and the spec with the hash of that text, so sizing takes
 * it only while the bounty still says it. `confirmedBy` is the poster, and
 * the credential they posted with, when they act as a person allowed to
 * confirm (`decisions:confirm`); else null, and the decisions start
 * unconfirmed.
 */
export async function postedBounty(
  input: CreateBountyInput & { readonly spec: PostedSpecInput },
  confirmedBy: {
    readonly userId: string;
    readonly credential: DecisionConfirmationCredential;
  } | null,
): Promise<
  | {
      readonly ok: true;
      readonly bounty: {
        readonly title: string;
        readonly description: string;
        readonly stack: readonly string[];
        readonly postedSpec: NewPostedSpec;
      };
    }
  | Extract<PostedSpecResult, { ok: false }>
> {
  const read = readPostedSpec(input.spec.document);
  if (!read.ok) return read;
  const description =
    input.description === "" ? input.spec.document : input.description;
  return {
    ok: true,
    bounty: {
      title: input.title,
      description,
      stack: input.stack,
      postedSpec: {
        document: input.spec.document,
        draft: read.draft,
        source: postedSpecSource(input.spec),
        specHash: await bountySpecHash(input.title, description),
        specHashVersion: BOUNTY_SPEC_HASH_VERSION,
        ...(input.spec.confirmed && confirmedBy !== null
          ? {
              confirmedBy: confirmedBy.userId,
              confirmedCredential: confirmedBy.credential,
            }
          : { confirmedBy: null, confirmedCredential: null }),
      },
    },
  };
}
