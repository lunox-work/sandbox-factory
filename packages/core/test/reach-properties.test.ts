/**
 * What `reach` promises of every graph, entry set and budget, checked on
 * generated graphs: the slice is inside the budget, every cut has exactly
 * one end inside it, every internal edge both, the walk is the plain
 * reachability closure when the budget is loose, and the array order of
 * the graph file changes nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as fc from "fast-check";

import {
  isTraversed,
  parseSliceGraph,
  reach,
  type CutEdge,
  type SliceBudget,
} from "../src/index.js";

const RELATIONS = [
  "imports",
  "calls",
  "uses_x",
  "contains",
  "defines",
] as const;
const CONFIDENCES = ["EXTRACTED", "INFERRED"] as const;

interface RawNode {
  readonly id: string;
  readonly source_file: string;
  readonly community?: number;
  readonly dependencyStatus?: "external" | "unresolved";
}
interface RawLink {
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly confidence: string;
  readonly specifier?: string;
  readonly source_location?: string;
}
interface RawGraph {
  readonly nodes: readonly RawNode[];
  readonly links: readonly RawLink[];
}

const file = (i: number) => `src/f${i}.ts`;

/** A graph of `count` files, some with a symbol, a dependency, and random links. */
const rawGraph: fc.Arbitrary<RawGraph> = fc
  .integer({ min: 1, max: 6 })
  .chain((count) => {
    const nodes: RawNode[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push({
        id: `file:${file(i)}`,
        source_file: file(i),
        community: i % 3,
      });
      if (i % 2 === 0)
        nodes.push({
          id: `symbol:${file(i)}:S${i}`,
          source_file: file(i),
          community: i % 3,
        });
    }
    nodes.push({
      id: `dependency:${file(0)}:pg`,
      source_file: file(0),
      dependencyStatus: "external",
    });
    const ids = nodes.map((node) => node.id);
    const link = fc.record({
      source: fc.constantFrom(...ids),
      target: fc.constantFrom(...ids),
      relation: fc.constantFrom(...RELATIONS),
      confidence: fc.constantFrom(...CONFIDENCES),
      specifier: fc.option(fc.constantFrom("./x.js", "@/y"), {
        nil: undefined,
      }),
    });
    return fc
      .array(link, { maxLength: count * 3 })
      .map((links) => ({ nodes, links }));
  });

const budget: fc.Arbitrary<SliceBudget> = fc.record({
  maxFiles: fc.integer({ min: 0, max: 7 }),
  maxDepth: fc.integer({ min: 0, max: 4 }),
});

const entriesOf = (graph: RawGraph) =>
  fc.subarray(
    graph.nodes
      .filter((node) => node.id.startsWith("file:"))
      .map((node) => node.source_file),
    { minLength: 1 },
  );

/** File-to-file edges the walk may follow, by the module's own rules. */
function traversable(graph: RawGraph, includeInferred: boolean) {
  const fileOf = new Map(
    graph.nodes.map((node) => [
      node.id,
      node.id.startsWith("dependency:") ? null : node.source_file,
    ]),
  );
  const edges: { from: string; to: string; specifier: string | null }[] = [];
  for (const link of graph.links) {
    if (!isTraversed(link.relation)) continue;
    if (link.confidence !== "EXTRACTED" && !includeInferred) continue;
    const from = fileOf.get(link.source) ?? null;
    const to = fileOf.get(link.target) ?? null;
    if (from === null || to === null || from === to) continue;
    edges.push({ from, to, specifier: link.specifier ?? null });
  }
  return edges;
}

/** Plain reachability, no budget: what a loose budget must reproduce. */
function closure(
  edges: readonly { from: string; to: string }[],
  entries: readonly string[],
): Set<string> {
  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const at = queue.shift();
    for (const edge of edges)
      if (edge.from === at && !seen.has(edge.to)) {
        seen.add(edge.to);
        queue.push(edge.to);
      }
  }
  return seen;
}

const within = (included: ReadonlySet<string>, edges: readonly CutEdge[]) =>
  edges.map((edge) => [included.has(edge.from), included.has(edge.to)]);

test("the slice is inside its budget, cuts straddle it, internal edges stay in, and depth is a shortest path", () => {
  fc.assert(
    fc.property(
      rawGraph.chain((graph) =>
        fc.tuple(fc.constant(graph), entriesOf(graph), budget, fc.boolean()),
      ),
      ([graph, entries, limits, includeInferred]) => {
        const result = reach(parseSliceGraph(graph), entries, limits, {
          includeInferred,
        });
        const included = new Set(result.included);
        assert.deepEqual(result.unknownEntryPoints, []);
        assert.deepEqual(result.entries, [...new Set(entries)].sort());
        assert.ok(result.included.length <= limits.maxFiles);
        assert.deepEqual(result.included, [...included].sort());
        assert.deepEqual(Object.keys(result.depthOf).sort(), result.included);
        const edges = traversable(graph, includeInferred);
        for (const path of result.included) {
          const depth = result.depthOf[path];
          assert.ok(
            depth !== undefined && depth >= 0 && depth <= limits.maxDepth,
          );
          if (entries.includes(path)) assert.equal(depth, 0);
          else {
            // Reached from an included file one edge nearer.
            assert.ok(
              edges.some(
                (edge) =>
                  edge.to === path && result.depthOf[edge.from] === depth - 1,
              ),
            );
          }
        }
        for (const [from, to] of within(included, result.cuts.outbound))
          assert.ok(from && !to);
        for (const [from, to] of within(included, result.cuts.inbound))
          assert.ok(!from && to);
        for (const edge of result.internal) {
          assert.ok(included.has(edge.from) && included.has(edge.to));
          assert.notEqual(edge.specifier, null);
        }
        // Every followed edge leaving an included file is a cut, or
        // internal when it carries a specifier; one arriving is a cut.
        const lists = (
          list: readonly CutEdge[],
          edge: (typeof edges)[number],
        ) =>
          list.some(
            (e) =>
              e.from === edge.from &&
              e.to === edge.to &&
              e.specifier === edge.specifier,
          );
        for (const edge of edges)
          if (included.has(edge.from)) {
            if (included.has(edge.to))
              assert.equal(
                lists(result.internal, edge),
                edge.specifier !== null,
              );
            else assert.ok(lists(result.cuts.outbound, edge));
          } else if (included.has(edge.to)) {
            assert.ok(lists(result.cuts.inbound, edge));
          }
        // Nothing is reached that the closure cannot reach.
        const reachable = closure(edges, entries);
        for (const path of result.included) assert.ok(reachable.has(path));
        // A loose budget is the closure exactly, with no outbound cut.
        const loose = reach(
          parseSliceGraph(graph),
          entries,
          { maxFiles: 10, maxDepth: 10 },
          { includeInferred },
        );
        assert.deepEqual(new Set(loose.included), reachable);
        assert.deepEqual(loose.cuts.outbound, []);
      },
    ),
    { numRuns: 1_500 },
  );
});

test("the order of the graph file's arrays changes nothing", () => {
  fc.assert(
    fc.property(
      rawGraph.chain((graph) =>
        fc.tuple(
          fc.constant(graph),
          entriesOf(graph),
          budget,
          fc.shuffledSubarray([...graph.nodes], {
            minLength: graph.nodes.length,
          }),
          fc.shuffledSubarray([...graph.links], {
            minLength: graph.links.length,
          }),
        ),
      ),
      ([graph, entries, limits, nodes, links]) => {
        const sorted = reach(parseSliceGraph(graph), entries, limits);
        const shuffled = reach(
          parseSliceGraph({ nodes, links }),
          [...entries].reverse(),
          limits,
        );
        assert.deepEqual(shuffled, sorted);
      },
    ),
    { numRuns: 1_000 },
  );
});
