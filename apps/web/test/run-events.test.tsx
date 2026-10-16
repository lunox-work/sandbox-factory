import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { nextRunChange, resetRunStreams } from "../src/data/events";
import {
  analysisTopic,
  observeUntil,
  PUSHED_INTERVAL_MS,
  useObservation,
} from "../src/data/observe";
import { renderHook } from "./render";

/**
 * The push channel, with the browser's `EventSource` played by a fake: one
 * stream per workspace, each change reading again what follows it.
 */

class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  closed = false;
  readyState = 0;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.opened.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data = "{}") {
    for (const listener of this.listeners.get(type) ?? [])
      listener(new MessageEvent(type, { data }));
  }
  change(kind: string, id: string) {
    this.emit("change", JSON.stringify({ kind, id }));
  }
}

beforeEach(() => {
  FakeEventSource.opened = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  resetRunStreams();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const running = { id: "arn_1", status: "running" };

function follow(read: () => Promise<{ id: string; status: string }>) {
  return renderHook(() =>
    useObservation({
      owner: "org_1",
      resource: "analysis-run",
      id: "arn_1",
      read,
      terminal: (run) => run.status !== "running",
      interval: 2_000,
      topics: (id) => [analysisTopic(id)],
    }),
  );
}

test("a change to what a view follows reads it again at once", async () => {
  const read = vi.fn(async () => running);
  follow(read);
  // Followed once its first read says it is still going.
  await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
  expect(read).toHaveBeenCalledTimes(1);
  const [stream] = FakeEventSource.opened;
  expect(stream?.url).toBe("/api/v1/orgs/org_1/events");
  expect(stream?.init?.withCredentials).toBe(true);
  act(() => stream?.emit("ready"));
  // Another run's change is not this view's.
  act(() => stream?.change("analysis", "arn_other"));
  act(() => stream?.change("bounty", "arn_1"));
  expect(read).toHaveBeenCalledTimes(1);
  act(() => stream?.change("analysis", "arn_1"));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

test("while the stream is open the view's own timer slows, and a reopened one reads again", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const read = vi.fn(async () => running);
  follow(read);
  await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
  const [stream] = FakeEventSource.opened;
  // Not open yet: the view keeps its own pace.
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(read).toHaveBeenCalledTimes(2);
  act(() => stream?.emit("ready"));
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  await act(() => vi.advanceTimersByTimeAsync(4_000));
  const settled = read.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(PUSHED_INTERVAL_MS - 8_000));
  expect(read.mock.calls.length).toBeLessThanOrEqual(settled + 1);
  // Dropped and open again: what changed meanwhile went unsaid.
  const before = read.mock.calls.length;
  act(() => stream?.emit("error"));
  act(() => stream?.emit("ready"));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
});

test("a stream the browser gives up on is opened anew, and reads again once open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const read = vi.fn(async () => running);
  follow(read);
  await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
  const [first] = FakeEventSource.opened;
  act(() => first?.emit("ready"));
  // An HTTP error on reconnecting, as a deploy gives: the browser closes it
  // for good, where a dropped connection it retries itself.
  const before = read.mock.calls.length;
  if (first !== undefined) first.readyState = 2;
  act(() => first?.emit("error"));
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(FakeEventSource.opened).toHaveLength(2);
  const second = FakeEventSource.opened[1];
  expect(second?.url).toBe("/api/v1/orgs/org_1/events");
  act(() => second?.emit("ready"));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  // Its changes reach the view as the first one's did.
  const reads = read.mock.calls.length;
  act(() => second?.change("analysis", "arn_1"));
  await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
});

test("views of one workspace share its stream, which closes after them", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const read = vi.fn(async () => running);
  const first = follow(read);
  const second = follow(read);
  await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
  await act(() => Promise.resolve());
  expect(FakeEventSource.opened).toHaveLength(1);
  first.unmount();
  second.unmount();
  expect(FakeEventSource.opened[0]?.closed).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(FakeEventSource.opened[0]?.closed).toBe(true);
});

test("a view with nothing to follow, or a settled one, opens no stream", async () => {
  const read = vi.fn(async () => ({ id: "arn_1", status: "succeeded" }));
  follow(read);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await act(() => Promise.resolve());
  expect(FakeEventSource.opened).toHaveLength(0);
});

test("a wait between reads ends as soon as its topic changes", async () => {
  let reads = 0;
  const done = observeUntil({
    initial: { id: "brn_1", status: "running" },
    read: async (id) => {
      reads += 1;
      return { id, status: reads > 1 ? "succeeded" : "running" };
    },
    id: (run) => run.id,
    terminal: (run) => run.status === "succeeded",
    // Far longer than the test: only the push can end the waits.
    interval: 60_000,
    pushed: { owner: "org_1", topic: (run) => `bounty:${run.id}` },
  });
  await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
  const [stream] = FakeEventSource.opened;
  stream?.change("bounty", "brn_1");
  await waitFor(() => expect(reads).toBe(1));
  stream?.change("bounty", "brn_1");
  expect(await done).toEqual({ id: "brn_1", status: "succeeded" });
});

test("without EventSource, a wait is its timer alone", () => {
  vi.stubGlobal("EventSource", undefined);
  const { stop } = nextRunChange("org_1", "bounty:brn_1");
  stop();
  expect(FakeEventSource.opened).toHaveLength(0);
});
