const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

// Exercise the manual script with its model and file boundaries replaced.
// No API credentials or model calls are needed for evaluation arithmetic.
async function evaluate(examples, draft) {
  const source = readFileSync(
    resolve(__dirname, "../../apps/api/scripts/evaluate-bounties.mjs"),
    "utf8",
  ).replace(/^import[\s\S]*?;\n/gm, "");
  let result;
  await runInNewContext(`(async () => { ${source} })()`, {
    SCENARIO_WEIGHTS: ["light", "moderate", "heavy"],
    WHOLE_BOUNTY_COMPLEXITIES: ["XS", "S", "M", "L", "XL"],
    process: {
      argv: ["node", "evaluate", "fixture.jsonl"],
      env: { ANTHROPIC_API_KEY: "fake", SIZING_MODEL: "fake" },
    },
    readFile: async () =>
      examples.map((value) => JSON.stringify(value)).join("\n"),
    AnthropicCaller: class {
      async call(tool, input) {
        return {
          result:
            tool.name === "size_bounty"
              ? { complexity: "M" }
              : { scenarios: await draft(input) },
        };
      }
    },
    sizeBountyTool: { name: "size_bounty", promptVersion: "size" },
    draftSpecTool: { name: "draft_spec", promptVersion: "draft" },
    console: {
      log: (value) => {
        result = JSON.parse(value);
      },
    },
  });
  return result;
}

function example(summary, outline) {
  return {
    summary,
    descriptionText: "Change",
    issueType: "Story",
    label: "M",
    scenarios: [{ title: "works", weight: "heavy" }],
    ...(outline ? { repositoryOutline: "Repository modules" } : {}),
  };
}

test("outline delta compares the same examples in a mixed dataset", async () => {
  const result = await evaluate(
    [example("outlined", true), example("other", false)],
    (input) => [
      {
        title: "works",
        weight: input.summary === "outlined" ? "heavy" : "light",
      },
    ],
  );
  assert.equal(result.weightAgreement, 0.5);
  assert.equal(result.outlineWeightAgreement, 1);
  assert.equal(result.outlineWeightAgreementDelta, 0);
});

test("outline delta uses only scenario labels matched in both drafts", async () => {
  const value = example("outlined", true);
  value.scenarios.push({ title: "extra", weight: "heavy" });
  const result = await evaluate([value], (input) =>
    input.repositoryOutline
      ? [{ title: "works", weight: "heavy" }]
      : [
          { title: "works", weight: "heavy" },
          { title: "extra", weight: "light" },
        ],
  );
  assert.equal(result.outlineWeightAgreementDelta, 0);
  assert.equal(result.pairedWeightCount, 1);
});

test("a failed baseline draft cannot produce an outline improvement delta", async () => {
  const result = await evaluate([example("outlined", true)], (input) => {
    if (!input.repositoryOutline) throw new Error("model unavailable");
    return [{ title: "works", weight: "heavy" }];
  });
  assert.equal(result.outlineWeightAgreementDelta, null);
});
