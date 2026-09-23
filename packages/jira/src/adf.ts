/**
 * Atlassian Document Format to plain text.
 *
 * Jira Cloud returns an issue description as ADF — a recursive JSON tree, not
 * a string — so there is no ticket spec to read without this. The output feeds
 * two things, and both shape the design:
 *
 * - **The sizing prompt.** A model reads it, so structure that carries meaning
 *   (headings, list items, checkboxes, table rows) has to survive as text.
 *   Acceptance criteria are usually a bullet list, and flattening one into a
 *   run-on paragraph is how a sized ticket loses the thing that made it
 *   sizable.
 * - **The spec hash.** Two reads of an unchanged ticket must produce the same
 *   string, or every proposal would show as stale. So nothing here depends on
 *   iteration order of anything but the `content` arrays themselves.
 *
 * **Unknown nodes never throw.** ADF gains node types, and a ticket using one
 * must still be readable: an unrecognised node contributes its `text` and its
 * children, and nothing else. The alternative — failing the parse — turns a
 * new Atlassian feature into an outage for the whole board.
 */

/** Hard cap on the produced text. */
const MAX_LENGTH = 20_000;

/**
 * How deep the walk will go before giving up on a branch.
 *
 * ADF nests legitimately (a table holds cells, which hold lists, which hold
 * paragraphs) but not deeply. The limit is a guard against a hostile or
 * malformed document, since this runs on input the platform does not control
 * and recursion here would otherwise be unbounded.
 */
const MAX_DEPTH = 50;

/** One node of the tree. Everything is optional: this is untrusted input. */
interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
  attrs?: Record<string, unknown> | undefined;
}

export interface AdfTextResult {
  readonly text: string;
  /** True when either the depth or output cap omitted source content. */
  readonly truncated: boolean;
}

interface WalkState {
  truncated: boolean;
}

function asNode(value: unknown): AdfNode | undefined {
  return typeof value === "object" && value !== null
    ? (value as AdfNode)
    : undefined;
}

function childrenOf(node: AdfNode): unknown[] {
  return Array.isArray(node.content) ? node.content : [];
}

/**
 * Flattens an ADF document to plain text.
 *
 * Accepts `unknown` rather than a typed document: the caller has just parsed
 * a Jira payload, and a description can also be null (no description), a
 * string (a site still on the old wiki-markup renderer), or a shape nobody
 * anticipated. All of those answer with a string, never an exception.
 */
export function adfToText(document: unknown): string {
  return adfToTextResult(document).text;
}

/** Flattens ADF while preserving whether any source content was omitted. */
export function adfToTextResult(document: unknown): AdfTextResult {
  // A pre-ADF site sends the description as a plain string.
  if (typeof document === "string") {
    return clamp(normalizeWhitespace(document), false);
  }

  const root = asNode(document);
  if (root === undefined) {
    return { text: "", truncated: false };
  }

  const blocks: string[] = [];
  const state: WalkState = { truncated: false };
  collectBlocks(root, blocks, 0, "", state);
  return clamp(
    blocks
      .map((block) => block.trimEnd())
      .filter((block) => block !== "")
      .join("\n\n"),
    state.truncated,
  );
}

/**
 * Walks the tree, appending one entry to `blocks` per block-level node.
 *
 * Inline content is gathered by `inlineText`, so a paragraph becomes one entry
 * rather than one per text run; `prefix` carries list markers down to the
 * paragraph that actually holds the words.
 */
function collectBlocks(
  node: AdfNode,
  blocks: string[],
  depth: number,
  prefix: string,
  state: WalkState,
): void {
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return;
  }

  const type = typeof node.type === "string" ? node.type : "";

  switch (type) {
    case "heading": {
      const level = Number(node.attrs?.["level"] ?? 1);
      const hashes = "#".repeat(
        Number.isFinite(level) ? Math.min(Math.max(level, 1), 6) : 1,
      );
      // Kept as Markdown: the model reads these as structure, and a heading
      // stripped to bare text is indistinguishable from a sentence.
      pushInline(blocks, `${hashes} `, node, depth, state);
      return;
    }

    case "paragraph": {
      pushInline(blocks, prefix, node, depth, state);
      return;
    }

    case "codeBlock": {
      const language =
        typeof node.attrs?.["language"] === "string"
          ? String(node.attrs["language"])
          : "";
      const body = inlineText(node, depth + 1, state);
      blocks.push(`\`\`\`${language}\n${body}\n\`\`\``);
      return;
    }

    case "blockquote": {
      const inner: string[] = [];
      for (const child of childrenOf(node)) {
        const childNode = asNode(child);
        if (childNode !== undefined) {
          collectBlocks(childNode, inner, depth + 1, "", state);
        }
      }
      blocks.push(inner.map((line) => `> ${line}`).join("\n"));
      return;
    }

    case "bulletList":
    case "orderedList": {
      // `order` is the starting number and may be absent or non-numeric.
      const rawOrder = Number(node.attrs?.["order"] ?? 1);
      let index = Number.isFinite(rawOrder) ? rawOrder : 1;
      for (const child of childrenOf(node)) {
        const item = asNode(child);
        if (item === undefined) {
          continue;
        }
        const marker = type === "bulletList" ? "- " : `${index}. `;
        index += 1;
        // The marker goes to the item's first paragraph; anything after it is
        // indented under the same bullet.
        const itemBlocks: string[] = [];
        for (const grandchild of childrenOf(item)) {
          const grandchildNode = asNode(grandchild);
          if (grandchildNode !== undefined) {
            collectBlocks(grandchildNode, itemBlocks, depth + 1, "", state);
          }
        }
        const [first, ...rest] = itemBlocks;
        if (first !== undefined) {
          blocks.push(`${prefix}${marker}${first}`);
        }
        for (const extra of rest) {
          blocks.push(`${prefix}  ${extra}`);
        }
      }
      return;
    }

    case "taskList": {
      for (const child of childrenOf(node)) {
        const item = asNode(child);
        if (item === undefined) {
          continue;
        }
        // Acceptance criteria are often a task list, and whether a box is
        // ticked is exactly what says how much work is left.
        const done = item.attrs?.["state"] === "DONE";
        const text = inlineText(item, depth + 1, state);
        blocks.push(`${prefix}- [${done ? "x" : " "}] ${text}`);
      }
      return;
    }

    case "table": {
      // One block for the whole table, not one per row. Blocks are joined
      // with a blank line, which between two rows ends the table and leaves
      // a run of stray paragraphs that happen to start with a pipe.
      const rows: string[] = [];
      for (const row of childrenOf(node)) {
        const rowNode = asNode(row);
        if (rowNode === undefined) {
          continue;
        }
        const cells: string[] = [];
        for (const cell of childrenOf(rowNode)) {
          const cellNode = asNode(cell);
          if (cellNode === undefined) {
            continue;
          }
          const cellBlocks: string[] = [];
          collectBlocks(cellNode, cellBlocks, depth + 1, "", state);
          // A cell's own newlines would end the row, so a multi-paragraph
          // cell collapses to one line rather than breaking the table.
          cells.push(cellBlocks.join(" ").replace(/\s+/g, " ").trim());
        }
        rows.push(`| ${cells.join(" | ")} |`);

        // The delimiter GFM requires after the header row. Without it these
        // are not a table at all, which is how they read everywhere
        // downstream — in the UI and to the sizing model alike. ADF's first
        // row is the header when the table has one, and treating it as such
        // when it does not costs a row of styling rather than any meaning.
        if (rows.length === 1 && cells.length > 0) {
          rows.push(`| ${cells.map(() => "---").join(" | ")} |`);
        }
      }
      if (rows.length > 0) {
        blocks.push(rows.join("\n"));
      }
      return;
    }

    case "rule": {
      blocks.push("---");
      return;
    }

    case "mediaSingle":
    case "mediaGroup": {
      // Attachments are not fetched: the spec is the text. Naming them keeps
      // "there is a screenshot here" visible to the reader and the model.
      const count = childrenOf(node).length;
      blocks.push(count === 1 ? "[media]" : `[media x${count}]`);
      return;
    }

    default: {
      // Unknown, or a container we do not treat specially (doc, tableRow,
      // tableCell, panel, expand, listItem reached directly). Descend: its
      // children carry the text, and refusing to would drop the content of
      // every node type Atlassian adds after this was written.
      if (typeof node.text === "string" && node.text !== "") {
        blocks.push(`${prefix}${node.text}`);
        return;
      }
      for (const child of childrenOf(node)) {
        const childNode = asNode(child);
        if (childNode !== undefined) {
          collectBlocks(childNode, blocks, depth + 1, prefix, state);
        }
      }
    }
  }
}

/** Appends one block made of a node's inline content, if it has any. */
function pushInline(
  blocks: string[],
  prefix: string,
  node: AdfNode,
  depth: number,
  state: WalkState,
): void {
  const text = inlineText(node, depth + 1, state);
  if (text !== "") {
    blocks.push(`${prefix}${text}`);
  }
}

/**
 * The text of a node's inline descendants, concatenated.
 *
 * Handles the inline node types that carry words rather than formatting:
 * `text`, plus the three reference types whose *label* is the content, since
 * "assign to @Ada" loses its meaning if the mention flattens to nothing.
 */
function inlineText(node: AdfNode, depth: number, state: WalkState): string {
  if (depth > MAX_DEPTH) {
    state.truncated = true;
    return "";
  }

  const type = typeof node.type === "string" ? node.type : "";

  if (type === "text" && typeof node.text === "string") {
    return node.text;
  }

  if (type === "hardBreak") {
    return "\n";
  }

  if (type === "mention") {
    const label = node.attrs?.["text"];
    return typeof label === "string" ? label : "@unknown";
  }

  if (type === "emoji") {
    const shortName = node.attrs?.["shortName"];
    return typeof shortName === "string" ? shortName : "";
  }

  if (type === "inlineCard" || type === "blockCard") {
    // A linked issue or page: the URL is the only text there is, and it often
    // names the related ticket.
    const url = node.attrs?.["url"];
    return typeof url === "string" ? url : "";
  }

  if (type === "date") {
    const timestamp = node.attrs?.["timestamp"];
    return typeof timestamp === "string" ? timestamp : "";
  }

  let out = "";
  for (const child of childrenOf(node)) {
    const childNode = asNode(child);
    if (childNode !== undefined) {
      out += inlineText(childNode, depth + 1, state);
    }
  }
  return out;
}

/** Collapses runs of whitespace, so a reformatted ticket keeps its hash. */
function normalizeWhitespace(value: string): string {
  return value.replace(/[^\S\n]+/g, " ").trim();
}

/** Truncates to the cap, marking both the text and metadata when it happened. */
function clamp(value: string, alreadyTruncated: boolean): AdfTextResult {
  return value.length <= MAX_LENGTH
    ? { text: value, truncated: alreadyTruncated }
    : {
        text: `${value.slice(0, MAX_LENGTH)}\n[truncated]`,
        truncated: true,
      };
}
