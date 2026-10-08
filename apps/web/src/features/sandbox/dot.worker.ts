/**
 * Graphviz, compiled to WebAssembly, laying out a DOT graph off the page's
 * thread: a module graph of a few hundred files takes a second or two.
 */

import { instance } from "@viz-js/viz";

import type { DotReply, DotRequest } from "./diagrams";

/** This worker's scope, typed without the web worker library's globals. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DotRequest>) => void) | null;
  postMessage: (reply: DotReply) => void;
  location: { origin: string };
};

const viz = instance();

scope.onmessage = (event) => {
  // A dedicated worker hears only the page that made it, which posts with
  // no origin; anything else is not a drawing asked for.
  if (event.origin !== "" && event.origin !== scope.location.origin) return;
  const { id, source, defaults } = event.data;
  viz.then(
    (graphviz) => {
      let reply: DotReply;
      try {
        const result = graphviz.render(source, {
          format: "svg",
          engine: "dot",
          graphAttributes: defaults.graph,
          nodeAttributes: defaults.node,
          edgeAttributes: defaults.edge,
        });
        reply =
          result.status === "success"
            ? { id, svg: result.output }
            : {
                id,
                error:
                  result.errors.map((error) => error.message).join(" ") ||
                  "Graphviz could not draw this graph.",
              };
      } catch {
        reply = { id, error: "Graphviz could not draw this graph." };
      }
      scope.postMessage(reply);
    },
    () => scope.postMessage({ id, error: "Graphviz could not be loaded." }),
  );
};
