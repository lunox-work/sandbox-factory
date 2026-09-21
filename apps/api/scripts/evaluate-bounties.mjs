import { readFile } from "node:fs/promises";

import { AnthropicSizer } from "../dist/sizing/index.js";

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

const sizes = ["S", "M", "L", "XL"];
const examples = (await readFile(path, "utf8"))
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line, index) => {
    const value = JSON.parse(line);
    if (
      typeof value.summary !== "string" ||
      typeof value.descriptionText !== "string" ||
      typeof value.issueType !== "string" ||
      ![...sizes, "unsized"].includes(value.label)
    ) {
      throw new Error(`Invalid example on line ${index + 1}.`);
    }
    return value;
  });
if (examples.length === 0) throw new Error("The evaluation file is empty.");

const sizer = new AnthropicSizer({ apiKey, model });
let exact = 0;
let sizedPairs = 0;
let withinOne = 0;
let trueUnsized = 0;
let predictedUnsized = 0;
let correctUnsized = 0;
let technicalFailures = 0;
let inputTokens = 0;
let outputTokens = 0;

for (const example of examples) {
  try {
    const result = await sizer.size({
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
}

const evaluated = examples.length - technicalFailures;
const ratio = (numerator, denominator) =>
  denominator === 0 ? null : numerator / denominator;
console.log(
  JSON.stringify(
    {
      model,
      promptVersion: sizer.promptVersion,
      sampleCount: examples.length,
      evaluatedCount: evaluated,
      technicalFailures,
      exactAgreement: ratio(exact, evaluated),
      withinOneSizeAgreement: ratio(withinOne, sizedPairs),
      sizedPairCount: sizedPairs,
      unsizedPrecision: ratio(correctUnsized, predictedUnsized),
      unsizedRecall: ratio(correctUnsized, trueUnsized),
      inputTokens,
      outputTokens,
    },
    null,
    2,
  ),
);
