/**
 * A Gherkin `.feature` file read into its parts, enough to lay it out as a
 * document: the feature, its background and scenarios, their steps, and the
 * tables and doc strings under them. Pure, and forgiving: a line it does not
 * understand is left out rather than failing the file.
 */

export type StepKeyword = "Given" | "When" | "Then" | "And" | "But" | "*";

export interface Step {
  keyword: StepKeyword;
  text: string;
  /** 1-based, in the file. */
  line: number;
  table?: string[][];
  docString?: string;
}

export interface Examples {
  name: string;
  table: string[][];
}

export interface Scenario {
  kind: "background" | "scenario" | "outline";
  name: string;
  tags: string[];
  line: number;
  steps: Step[];
  examples: Examples[];
}

export interface Feature {
  name: string;
  description: string;
  tags: string[];
  /** Background first, when there is one, then each scenario in order. */
  scenarios: Scenario[];
}

const FEATURE = /^(Feature|Ability|Business Need):\s*(.*)$/;
const BACKGROUND = /^Background:\s*(.*)$/;
const SCENARIO = /^(Scenario|Example):\s*(.*)$/;
const OUTLINE = /^Scenario (Outline|Template):\s*(.*)$/;
const EXAMPLES = /^(Examples|Scenarios):\s*(.*)$/;
const RULE = /^Rule:/;
const STEP = /^(Given|When|Then|And|But|\*)\s+(.*)$/;
const FENCE = /^("""|```)/;

function cells(line: string): string[] {
  return line
    .slice(1, line.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((cell) => cell.trim());
}

export function parseFeature(text: string): Feature {
  const feature: Feature = {
    name: "",
    description: "",
    tags: [],
    scenarios: [],
  };
  const description: string[] = [];
  let tags: string[] = [];
  let scenario: Scenario | undefined;
  let examples: Examples | undefined;
  let fence: { marker: string; lines: string[]; step: Step } | undefined;

  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (fence !== undefined) {
      if (line.startsWith(fence.marker)) {
        fence.step.docString = fence.lines.join("\n");
        fence = undefined;
      } else {
        fence.lines.push(raw);
      }
      return;
    }
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("@")) {
      tags = [
        ...tags,
        ...line.split(/\s+/).filter((tag) => tag.startsWith("@")),
      ];
      return;
    }
    const start = (kind: Scenario["kind"], name: string) => {
      scenario = { kind, name, tags, line: index + 1, steps: [], examples: [] };
      feature.scenarios.push(scenario);
      examples = undefined;
      tags = [];
    };
    let match: RegExpExecArray | null;
    if ((match = FEATURE.exec(line)) !== null) {
      feature.name = match[2] ?? "";
      feature.tags = tags;
      tags = [];
    } else if ((match = BACKGROUND.exec(line)) !== null) {
      start("background", match[1] ?? "");
    } else if ((match = OUTLINE.exec(line)) !== null) {
      start("outline", match[2] ?? "");
    } else if ((match = SCENARIO.exec(line)) !== null) {
      start("scenario", match[2] ?? "");
    } else if (RULE.test(line)) {
      tags = [];
    } else if ((match = EXAMPLES.exec(line)) !== null) {
      if (scenario === undefined) return;
      examples = { name: match[2] ?? "", table: [] };
      scenario.examples.push(examples);
      tags = [];
    } else if ((match = STEP.exec(line)) !== null && scenario !== undefined) {
      scenario.steps.push({
        keyword: match[1] as StepKeyword,
        text: match[2] ?? "",
        line: index + 1,
      });
      examples = undefined;
    } else if (line.startsWith("|")) {
      const step = scenario?.steps.at(-1);
      if (examples !== undefined) examples.table.push(cells(line));
      else if (step !== undefined)
        step.table = [...(step.table ?? []), cells(line)];
    } else if ((match = FENCE.exec(line)) !== null) {
      const step = scenario?.steps.at(-1);
      if (step !== undefined)
        fence = { marker: match[1] ?? '"""', lines: [], step };
    } else if (scenario === undefined && feature.name !== "") {
      description.push(line);
    }
  });
  feature.description = description.join("\n");
  return feature;
}

/** Scenarios, not counting the background. */
export function scenarioCount(feature: Feature): number {
  return feature.scenarios.filter(({ kind }) => kind !== "background").length;
}
