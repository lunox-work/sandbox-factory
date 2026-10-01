import { SCENARIO_WEIGHTS, WHOLE_BOUNTY_COMPLEXITIES } from "sandbox-factory";
import { readFile } from "node:fs/promises";

import {
  AnthropicCaller,
  draftSpecTool,
  sizeBountyTool,
} from "../dist/sizing/index.js";

const path = process.argv[2];
if (!path) {
  throw new Error(
    "Pass an explicit JSONL path: npm run evaluate:bounties -w @sandbox-factory/api -- <file>",
  );
}
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
      typeof value.issueType !== "string" ||
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

for (const example of examples) {
  try {
    const result = await caller.call(sizeBountyTool, {
      summary: example.summary,
      descriptionText: example.descriptionText,
      issueType: example.issueType,
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
  try {
    const drafted = await caller.call(draftSpecTool, {
      summary: example.summary,
      descriptionText: example.descriptionText,
      issueType: example.issueType,
      components: example.components ?? [],
      labels: example.labels ?? [],
    });
    inputTokens += drafted.usage?.inputTokens ?? 0;
    outputTokens += drafted.usage?.outputTokens ?? 0;
    for (const label of example.scenarios) {
      const words = label.title.trim().toLowerCase();
      const match = drafted.result.scenarios.find(({ title }) =>
        title.toLowerCase().includes(words),
      );
      if (match?.weight === undefined) continue;
      matchedWeights += 1;
      if (match.weight === label.weight) agreedWeights += 1;
      if (
        Math.abs(
          SCENARIO_WEIGHTS.indexOf(match.weight) -
            SCENARIO_WEIGHTS.indexOf(label.weight),
        ) <= 1
      ) {
        withinOneWeight += 1;
      }
    }
  } catch {
    draftFailures += 1;
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
      inputTokens,
      outputTokens,
    },
    null,
    2,
  ),
);
