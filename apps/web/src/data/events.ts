import { runEventsPath } from "@sandbox-factory/client";
import { useEffect, useRef, useState } from "react";

/**
 * The workspace's push channel: one `EventSource` per workspace, shared by
 * every view following something in it, saying which run or proposal just
 * changed. A view reads that thing again when told, rather than on its
 * second-by-second timer; the timer stays, slower, for a change lost to a
 * reconnect, and at its own pace wherever the channel is not open.
 *
 * A topic is `<kind>:<id>`: `analysis:<runId>`, `bounty:<runId>` or
 * `profile:<proposalId>` (a proposal's profiles, read together).
 */

type Listener = () => void;

interface Stream {
  source: EventSource;
  readonly topics: Map<string, Set<Listener>>;
  readonly openness: Set<(open: boolean) => void>;
  open: boolean;
  /** Whether it has been open before: a later `ready` is a reopening. */
  opened: boolean;
  users: number;
  closing: ReturnType<typeof setTimeout> | null;
  /** A source the browser gave up on, waiting to be opened anew. */
  retrying: ReturnType<typeof setTimeout> | null;
  retryMs: number;
}

/**
 * How long a stream nobody follows is kept, so moving between pages that
 * follow the same workspace does not open it again.
 */
const LINGER_MS = 10_000;

/**
 * How long after the browser gives up on a stream (an HTTP error, as a
 * deploy gives, rather than a dropped connection it retries itself) it is
 * opened anew, doubling to the most.
 */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** `EventSource.CLOSED`, which the browser does not open again. */
const CLOSED = 2;

const streams = new Map<string, Stream>();

/** Whether this platform can follow a stream at all; jsdom cannot. */
export const pushAvailable = () => typeof EventSource !== "undefined";

function streamFor(owner: string): Stream {
  const existing = streams.get(owner);
  if (existing !== undefined) {
    if (existing.closing !== null) clearTimeout(existing.closing);
    existing.closing = null;
    return existing;
  }
  const stream: Stream = {
    source: connect(owner),
    topics: new Map(),
    openness: new Set(),
    open: false,
    opened: false,
    users: 0,
    closing: null,
    retrying: null,
    retryMs: RETRY_MS,
  };
  listen(owner, stream);
  streams.set(owner, stream);
  return stream;
}

function connect(owner: string): EventSource {
  return new EventSource(runEventsPath(owner), { withCredentials: true });
}

function listen(owner: string, stream: Stream) {
  const { source } = stream;
  const setOpen = (open: boolean) => {
    if (stream.open === open) return;
    stream.open = open;
    for (const listener of stream.openness) listener(open);
  };
  source.addEventListener("ready", () => {
    // Opened again after a drop: whatever changed meanwhile went unsaid,
    // so everything followed is read again.
    const reopened = stream.opened && !stream.open;
    stream.opened = true;
    stream.retryMs = RETRY_MS;
    setOpen(true);
    if (reopened)
      for (const listeners of stream.topics.values())
        for (const listener of listeners) listener();
  });
  source.addEventListener("change", (event) => {
    const topic = topicOf((event as MessageEvent<string>).data);
    if (topic === null) return;
    for (const listener of stream.topics.get(topic) ?? []) listener();
  });
  // The browser opens it again by itself, unless it has given up; until
  // then, the timers run.
  source.addEventListener("error", () => {
    setOpen(false);
    if (source.readyState !== CLOSED || stream.retrying !== null) return;
    if (streams.get(owner) !== stream || stream.source !== source) return;
    stream.retrying = setTimeout(() => {
      stream.retrying = null;
      if (streams.get(owner) !== stream) return;
      stream.source = connect(owner);
      listen(owner, stream);
    }, stream.retryMs);
    stream.retryMs = Math.min(stream.retryMs * 2, RETRY_MAX_MS);
  });
}

function topicOf(data: string): string | null {
  try {
    const { kind, id } = JSON.parse(data) as { kind?: unknown; id?: unknown };
    return typeof kind === "string" && typeof id === "string"
      ? `${kind}:${id}`
      : null;
  } catch {
    return null;
  }
}

function release(owner: string, stream: Stream) {
  stream.users -= 1;
  if (stream.users > 0) return;
  stream.closing = setTimeout(() => {
    if (stream.retrying !== null) clearTimeout(stream.retrying);
    stream.source.close();
    streams.delete(owner);
  }, LINGER_MS);
}

/**
 * Calls `onChange` whenever one of `topics` changes in `owner`'s
 * workspace. Answers whether the stream is open now: while it is, a view
 * may wait longer between reads of its own.
 */
export function useRunChanges(
  owner: string,
  topics: readonly string[],
  onChange: () => void,
): boolean {
  const [open, setOpen] = useState(false);
  const changed = useRef(onChange);
  changed.current = onChange;
  // One subscription per set of topics, whatever order they come in.
  const key = [...new Set(topics)].sort().join(" ");
  useEffect(() => {
    if (key === "" || owner === "" || !pushAvailable()) {
      setOpen(false);
      return;
    }
    const stream = streamFor(owner);
    stream.users += 1;
    const listener: Listener = () => changed.current();
    const followed = key.split(" ");
    for (const topic of followed) {
      let listeners = stream.topics.get(topic);
      if (listeners === undefined) {
        listeners = new Set();
        stream.topics.set(topic, listeners);
      }
      listeners.add(listener);
    }
    stream.openness.add(setOpen);
    setOpen(stream.open);
    return () => {
      for (const topic of followed) {
        const listeners = stream.topics.get(topic);
        listeners?.delete(listener);
        if (listeners?.size === 0) stream.topics.delete(topic);
      }
      stream.openness.delete(setOpen);
      release(owner, stream);
    };
  }, [owner, key]);
  return open;
}

/**
 * Resolves on the next change to `topic`, or never; the function it comes
 * with stops listening. For a loop that waits between reads, so it can stop
 * waiting the moment there is something to read.
 */
export function nextRunChange(
  owner: string,
  topic: string,
): { changed: Promise<void>; stop: () => void } {
  if (!pushAvailable() || owner === "")
    return { changed: new Promise(() => {}), stop: () => {} };
  const stream = streamFor(owner);
  stream.users += 1;
  let resolve = () => {};
  const changed = new Promise<void>((done) => {
    resolve = done;
  });
  const listener: Listener = () => resolve();
  let listeners = stream.topics.get(topic);
  if (listeners === undefined) {
    listeners = new Set();
    stream.topics.set(topic, listeners);
  }
  listeners.add(listener);
  let stopped = false;
  return {
    changed,
    stop: () => {
      if (stopped) return;
      stopped = true;
      const held = stream.topics.get(topic);
      held?.delete(listener);
      if (held?.size === 0) stream.topics.delete(topic);
      release(owner, stream);
    },
  };
}

/**
 * Opens anew every stream the browser has closed without a word, as
 * `window.stop()` does: it closes the page's streams outright, firing no
 * error, so nothing above would open them again. Each is shut until its
 * new source is ready, which then reads again everything it follows.
 */
export function reopenRunStreams() {
  for (const [owner, stream] of streams) {
    if (stream.source.readyState !== CLOSED) continue;
    if (stream.retrying !== null) clearTimeout(stream.retrying);
    stream.retrying = null;
    if (stream.open) {
      stream.open = false;
      for (const listener of stream.openness) listener(false);
    }
    stream.source = connect(owner);
    listen(owner, stream);
  }
}

/** For tests: forgets every stream, closing each. */
export function resetRunStreams() {
  for (const stream of streams.values()) {
    if (stream.closing !== null) clearTimeout(stream.closing);
    if (stream.retrying !== null) clearTimeout(stream.retrying);
    stream.source.close();
  }
  streams.clear();
}
