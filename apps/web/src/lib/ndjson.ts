/**
 * Hands each line of a newline-delimited JSON body to `onLine` as it
 * arrives, rather than once the whole body has.
 *
 * A line that is not JSON is skipped rather than ending the read: one bad
 * line should cost that line, not the ones after it. Resolves when the body
 * ends; rejects if the read itself fails, as an aborted fetch does.
 */
export async function readNdjson(
  body: ReadableStream<Uint8Array>,
  onLine: (value: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = (line: string) => {
    if (line.trim() === "") return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    onLine(value);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // `stream: true` so a character split across two chunks is held, not
    // turned into a replacement character.
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  emit(buffer + decoder.decode());
}
