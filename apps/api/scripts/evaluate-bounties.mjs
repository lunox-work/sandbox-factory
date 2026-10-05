import {
  SCENARIO_WEIGHTS,
  treeFacts,
  WHOLE_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";
import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  AnthropicCaller,
  draftSpecTool,
  repositoryOutline,
  sizeBountyTool,
} from "../dist/sizing/index.js";

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  throw new Error(
    "Pass an explicit JSONL path: npm run evaluate:bounties -w @sandbox-factory/api -- <file> [--outline-repo <checkout>]",
  );
}

/**
 * `--outline-repo <checkout>`: a local clone of the repository the examples
 * are about. Its tracked files are outlined as a snapshot of them would be,
 * and every labelled example is drafted twice, without and with it, so the
 * weight agreement can be compared. An example may carry its own
 * `repositoryOutline` text instead.
 */
async function outlineOfCheckout(directory) {
  const paths = execFileSync("git", ["-C", directory, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const entries = [];
  for (const file of paths) {
    const size = await stat(join(directory, file))
      .then((info) => info.size)
      .catch(() => 0);
    entries.push({ path: file, size });
  }
  return repositoryOutline(treeFacts(entries));
}
const outlineFlag = flags.indexOf("--outline-repo");
const sharedOutline =
  outlineFlag === -1
    ? undefined
    : await outlineOfCheckout(flags[outlineFlag + 1] ?? "");
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.SIZING_MODEL;
if (!apiKey || !model) {
  throw new Error(
    "ANTHROPIC_API_KEY and SIZING_MODEL are required for manual evaluation.",
  );
}

// The model answers whole sizes, so that is what a label is in.
const sizes = WHOLE_BOUNTY_COMPLEXITIES;

/**
 * An example may label scenario weights: `scenarios` is a list of
 * `{ "title": "words", "weight": "heavy" }`, each matched to the first
 * drafted scenario whose title contains the words, ignoring case. A
 * labelled scenario the draft did not write is counted as unmatched, not as
 * a disagreement: the weight is what is being measured, not the draft.
 */
function validScenarioLabels(scenarios) {
  return (
    scenarios === undefined ||
    (Array.isArray(scenarios) &&
      scenarios.every(
        (label) =>
          typeof label?.title === "string" &&
          label.title.trim() !== "" &&
          SCENARIO_WEIGHTS.includes(label.weight),
      ))
  );
}

const examples = (await readFile(path, "utf8"))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index) => {
    const value = JSON.parse(line);
    if (
      typeof value.summary !== "string" ||
      typeof value.descriptionText !== "string" ||
      ![...sizes, "unsized"].includes(value.label) ||
      !validScenarioLabels(value.scenarios)
    ) {
      throw new Error(`Invalid example on line ${index + 1}.`);
    }
    return value;
  });
if (examples.length === 0) throw new Error("The evaluation file is empty.");

const caller = new AnthropicCaller({ apiKey, model });
let exact = 0;
let sizedPairs = 0;
let withinOne = 0;
let trueUnsized = 0;
let predictedUnsized = 0;
let correctUnsized = 0;
let technicalFailures = 0;
let inputTokens = 0;
let outputTokens = 0;
let labelledWeights = 0;
let matchedWeights = 0;
let agreedWeights = 0;
let withinOneWeight = 0;
let draftFailures = 0;
// The same counts for the drafts shown a repository outline.
let outlineDrafts = 0;
let outlineMatchedWeights = 0;
let outlineAgreedWeights = 0;
let outlineWithinOneWeight = 0;
let outlineDraftFailures = 0;
let pairedWeights = 0;
let pairedBaselineAgreedWeights = 0;
let pairedOutlineAgreedWeights = 0;

for (const example of examples) {
  try {
    const result = await caller.call(sizeBountyTool, {
      summary: example.summary,
      descriptionText: example.descriptionText,
    });
    const predicted = result.result.complexity;
    if (predicted === example.label) exact += 1;
    if (example.label === "unsized") trueUnsized += 1;
    if (predicted === "unsized") predictedUnsized += 1;
    if (predicted === "unsized" && example.label === "unsized")
      correctUnsized += 1;
    if (predicted !== "unsized" && example.label !== "unsized") {
      sizedPairs += 1;
      if (
        Math.abs(sizes.indexOf(predicted) - sizes.indexOf(example.label)) <= 1
      ) {
        withinOne += 1;
      }
    }
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
  } catch {
    technicalFailures += 1;
  }

  if (example.scenarios === undefined) continue;
  labelledWeights += example.scenarios.length;
  const bounty = {
    summary: example.summary,
    descriptionText: example.descriptionText,
    components: example.components ?? [],
  };
  /** Each labelled weight against the draft: [matched, agreed, withinOne]. */
  const matchFor = (scenarios, label) =>
    scenarios.find(({ title }) =>
      title.toLowerCase().includes(label.title.trim().toLowerCase()),
    );
  const compare = (scenarios, counterpart) => {
    const counts = [0, 0, 0];
    for (const label of example.scenarios) {
      const match = matchFor(scenarios, label);
      if (match?.weight === undefined) continue;
      if (
        counterpart !== undefined &&
        matchFor(counterpart, label)?.weight === undefined
      )
        continue;
      counts[0] += 1;
      if (match.weight === label.weight) counts[1] += 1;
      if (
        Math.abs(
          SCENARIO_WEIGHTS.indexOf(match.weight) -
            SCENARIO_WEIGHTS.indexOf(label.weight),
        ) <= 1
      ) {
        counts[2] += 1;
      }
    }
    return counts;
  };
  let baselineScenarios;
  try {
    const drafted = await caller.call(draftSpecTool, bounty);
    baselineScenarios = drafted.result.scenarios;
    inputTokens += drafted.usage?.inputTokens ?? 0;
    outputTokens += drafted.usage?.outputTokens ?? 0;
    const [matched, agreed, within] = compare(drafted.result.scenarios);
    matchedWeights += matched;
    agreedWeights += agreed;
    withinOneWeight += within;
  } catch {
    draftFailures += 1;
  }

  const outline = example.repositoryOutline ?? sharedOutline;
  if (outline === undefined) continue;
  outlineDrafts += 1;
  try {
    const drafted = await caller.call(draftSpecTool, {
      ...bounty,
      repositoryOutline: outline,
    });
    inputTokens += drafted.usage?.inputTokens ?? 0;
    outputTokens += drafted.usage?.outputTokens ?? 0;
    const [matched, agreed, within] = compare(drafted.result.scenarios);
    outlineMatchedWeights += matched;
    outlineAgreedWeights += agreed;
    outlineWithinOneWeight += within;
    // The delta uses successful pairs of the same labelled scenarios.
    // Missing outlines, failed calls and unmatched titles cannot skew it.
    if (baselineScenarios !== undefined) {
      const [paired, baselineAgreed] = compare(
        baselineScenarios,
        drafted.result.scenarios,
      );
      const [, outlineAgreed] = compare(
        drafted.result.scenarios,
        baselineScenarios,
      );
      pairedWeights += paired;
      pairedBaselineAgreedWeights += baselineAgreed;
      pairedOutlineAgreedWeights += outlineAgreed;
    }
  } catch {
    outlineDraftFailures += 1;
  }
}

const evaluated = examples.length - technicalFailures;
const ratio = (numerator, denominator) =>
  denominator === 0 ? null : numerator / denominator;
console.log(
  JSON.stringify(
    {
      model,
      promptVersion: sizeBountyTool.promptVersion,
      sampleCount: examples.length,
      evaluatedCount: evaluated,
      technicalFailures,
      exactAgreement: ratio(exact, evaluated),
      withinOneSizeAgreement: ratio(withinOne, sizedPairs),
      sizedPairCount: sizedPairs,
      unsizedPrecision: ratio(correctUnsized, predictedUnsized),
      unsizedRecall: ratio(correctUnsized, trueUnsized),
      draftPromptVersion: draftSpecTool.promptVersion,
      draftFailures,
      labelledWeightCount: labelledWeights,
      matchedWeightCount: matchedWeights,
      weightAgreement: ratio(agreedWeights, matchedWeights),
      withinOneWeightAgreement: ratio(withinOneWeight, matchedWeights),
      // With an outline: the same examples drafted again beside it. The
      // delta is what the PR records; negative means the outline hurt.
      outlineDraftCount: outlineDrafts,
      outlineDraftFailures,
      outlineMatchedWeightCount: outlineMatchedWeights,
      outlineWeightAgreement: ratio(
        outlineAgreedWeights,
        outlineMatchedWeights,
      ),
      outlineWithinOneWeightAgreement: ratio(
        outlineWithinOneWeight,
        outlineMatchedWeights,
      ),
      pairedWeightCount: pairedWeights,
      pairedBaselineWeightAgreement: ratio(
        pairedBaselineAgreedWeights,
        pairedWeights,
      ),
      pairedOutlineWeightAgreement: ratio(
        pairedOutlineAgreedWeights,
        pairedWeights,
      ),
      outlineWeightAgreementDelta: ratio(
        pairedOutlineAgreedWeights - pairedBaselineAgreedWeights,
        pairedWeights,
      ),
      inputTokens,
      outputTokens,
    },
    null,
    2,
  ),
);
