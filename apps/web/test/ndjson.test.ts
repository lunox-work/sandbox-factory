import { expect, test } from "vitest";

import { readNdjson } from "../src/lib/ndjson";

/** A body that arrives in exactly these pieces. */
function chunked(...pieces: Array<string | Uint8Array>) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(
          typeof piece === "string" ? encoder.encode(piece) : piece,
        );
      }
      controller.close();
    },
  });
}

test("hands over each line as it completes, whatever the chunking", async () => {
  const lines: unknown[] = [];
  await readNdjson(
    chunked('{"id":"a"}\n{"id', '":"b"}\n', '{"id":"c"}'),
    (value) => lines.push(value),
  );
  // The last line needs no trailing newline.
  expect(lines).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
});

test("skips a line that is not JSON and keeps reading", async () => {
  const lines: unknown[] = [];
  await readNdjson(chunked('{"id":"a"}\n{oops\n\n{"id":"b"}\n'), (value) =>
    lines.push(value),
  );
  expect(lines).toEqual([{ id: "a" }, { id: "b" }]);
});

test("a character split across chunks survives", async () => {
  // "é" is two bytes in UTF-8; the chunk boundary falls between them.
  const bytes = new TextEncoder().encode('{"title":"café"}\n');
  const split = bytes.indexOf(0xc3) + 1;
  const lines: unknown[] = [];
  await readNdjson(
    chunked(bytes.slice(0, split), bytes.slice(split)),
    (value) => lines.push(value),
  );
  expect(lines).toEqual([{ title: "café" }]);
});
