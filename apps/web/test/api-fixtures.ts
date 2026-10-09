/** Complete wire fixtures for views that only exercise a subset of a DTO. */
const date = "2026-10-01T00:00:00.000Z";
const rates = {
  currency: "USD",
  xsMinor: 100,
  sMinor: 100,
  mMinor: 200,
  lMinor: 300,
  xlMinor: 400,
  revision: 1,
};
const proposalDefaults = {
  organizationId: "org_1",
  runId: "brn_1",
  bountyId: "bty_1",
  title: "",
  specHash: "a".repeat(64),
  specHashVersion: 1,
  rateCard: rates,
  modelComplexity: "M",
  modelConfidence: "high",
  modelRationale: "A bounded change.",
  unsizedReason: null,
  inputTruncated: false,
  actualModel: "test-model",
  promptVersion: "v1",
  complexity: "M",
  sizedBy: "model",
  resizedBy: null,
  resizedAt: null,
  amountMinor: 200,
  currency: "USD",
  status: "proposed",
  revision: 1,
  specRevision: null,
  repositories: [],
  step: null,
  decidedAt: null,
  decidedBy: null,
  decisionDeliveryPolicy: null,
  createdAt: date,
  updatedAt: date,
};
const runDefaults = {
  status: "queued",
  organizationId: "org_1",
  boardId: "jrb_1",
  bountyId: null,
  kind: "backlog",
  sourceProposalId: null,
  sourceRevision: null,
  respec: null,
  requestId: "00000000-0000-4000-8000-000000000000",
  selection: {},
  rateCard: rates,
  requestedModel: "test-model",
  promptVersion: "v1",
  planned: [],
  outcomes: [],
  candidatesScanned: 0,
  skippedLive: 0,
  scanLimitReached: false,
  fatalErrorCode: null,
  startedAt: null,
  deadlineAt: null,
  finishedAt: null,
  createdAt: date,
};
function row(value: unknown, defaults: object) {
  return typeof value === "object" && value !== null
    ? { ...defaults, ...value }
    : value;
}
export function completeBountyFixture(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const body = { ...value } as Record<string, unknown>;
  if (Array.isArray(body.proposals)) {
    body.proposals = body.proposals.map((value) =>
      row(value, proposalDefaults),
    );
    if (!("nextCursor" in body)) body.nextCursor = null;
  }
  if (body.rateCard !== undefined && body.rateCard !== null)
    body.rateCard = row(body.rateCard, { updatedAt: date });
  if (body.spec !== undefined && body.spec !== null)
    body.spec = row(body.spec, {
      organizationId: "org_1",
      specHash: "a".repeat(64),
      specHashVersion: 1,
      origin: "draft",
      instruction: null,
      createdBy: null,
      runId: "brn_1",
      actualModel: "test-model",
      promptVersion: "v1",
      createdAt: date,
    });
  if (body.proposal !== undefined)
    body.proposal = row(body.proposal, proposalDefaults);
  if (Array.isArray(body.runs))
    body.runs = body.runs.map((value) => row(value, runDefaults));
  if (body.run !== undefined) body.run = row(body.run, runDefaults);
  if (typeof body.freshness === "object" && body.freshness !== null) {
    const fresh = body.freshness as Record<string, unknown>;
    body.freshness = {
      ...fresh,
      checkedAt: fresh.checkedAt === "now" ? date : fresh.checkedAt,
    };
  }
  return body;
}
export function bountyJson(value: unknown, init?: ResponseInit) {
  return Response.json(completeBountyFixture(value), init);
}
