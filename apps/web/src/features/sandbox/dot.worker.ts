/**
 * Graphviz, compiled to WebAssembly, laying out a DOT graph off the page's
 * thread: a module graph of a few hundred files takes a second or two.
 */

import { instance } from "@viz-js/viz";

import type { DotReply } from "./diagrams";

/** This worker's scope, typed without the web worker library's globals. */
const scope = self as unknown as {
  onmessage:
    ((event: MessageEvent<{ id: number; source: string }>) => void) | null;
  postMessage: (reply: DotReply) => void;
};

const viz = instance();

scope.onmessage = (event) => {
  const { id, source } = event.data;
  viz.then(
    (graphviz) => {
      let reply: DotReply;
      try {
        const result = graphviz.render(source, {
          format: "svg",
          engine: "dot",
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
