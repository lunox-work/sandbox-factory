import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  ServerDataProvider,
  createQueryClient,
  queryKeys,
  useOwnerQuery,
} from "../src/data/query";
import { useObservation } from "../src/data/observe";
import { ApiError } from "@sandbox-factory/client";
afterEach(cleanup);

test("concurrent consumers share a read and a cache update reaches both", async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    return "first";
  };
  function Consumer({ id }: { id: string }) {
    const query = useOwnerQuery("org_1", "example", read);
    return (
      <div>
        <span data-testid={id}>{query.data}</span>
        <button onClick={() => query.setData(() => "changed")}>
          Change {id}
        </button>
      </div>
    );
  }
  render(
    <ServerDataProvider userId="one">
      <Consumer id="a" />
      <Consumer id="b" />
    </ServerDataProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("a").textContent).toBe("first"),
  );
  expect(calls).toBe(1);
  fireEvent.click(screen.getByText("Change a"));
  await waitFor(() =>
    expect(screen.getByTestId("b").textContent).toBe("changed"),
  );
});

test("owner and account changes cancel old reads without showing their results", async () => {
  let release: ((value: string) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  const read = (owner: string, signal: AbortSignal) =>
    owner === "old"
      ? new Promise<string>((resolve) => {
          release = resolve;
          oldSignal = signal;
        })
      : Promise.resolve(owner);
  function Consumer({ owner }: { owner: string }) {
    const query = useOwnerQuery(owner, "example", read);
    return <span data-testid="value">{query.data ?? "loading"}</span>;
  }
  const view = render(
    <ServerDataProvider userId="one">
      <Consumer owner="old" />
    </ServerDataProvider>,
  );
  await waitFor(() => expect(release).toBeDefined());
  view.rerender(
    <ServerDataProvider userId="one">
      <Consumer owner="new" />
    </ServerDataProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("value").textContent).toBe("new"),
  );
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => {
    release?.("stale");
  });
  expect(screen.getByTestId("value").textContent).toBe("new");
  view.rerender(
    <ServerDataProvider userId="two">
      <Consumer owner="other" />
    </ServerDataProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("value").textContent).toBe("other"),
  );
});

test("slow observation requests never overlap and stop at the terminal result", async () => {
  let calls = 0;
  let release: ((value: { status: string }) => void) | undefined;
  const read = () => {
    calls++;
    return new Promise<{ status: string }>((resolve) => {
      release = resolve;
    });
  };
  function Consumer() {
    const query = useObservation({
      owner: "org_1",
      resource: "run",
      id: "run_1",
      read,
      terminal: (value) => value.status === "done",
      interval: 10,
    });
    return <span>{query.data?.status ?? "loading"}</span>;
  }
  render(
    <ServerDataProvider userId="one">
      <Consumer />
    </ServerDataProvider>,
  );
  await waitFor(() => expect(calls).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(1);
  await act(async () => {
    release?.({ status: "done" });
  });
  await screen.findByText("done");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(1);
});

test("tracking failures stop automatic reads and deliberate retry resumes", async () => {
  let calls = 0;
  const read = async () => {
    calls++;
    if (calls === 1) throw new ApiError(401, "Expired");
    return { status: "done" };
  };
  function Consumer() {
    const query = useObservation({
      owner: "org_1",
      resource: "run",
      id: "run_1",
      read,
      terminal: (value) => value.status === "done",
      interval: 10,
    });
    return (
      <div>
        {query.isError ? "Tracking failed" : query.data?.status}
        <button
          onClick={() => {
            void query.refetch();
          }}
        >
          Retry tracking
        </button>
      </div>
    );
  }
  const cache = createQueryClient();
  render(
    <ServerDataProvider userId="one" client={cache}>
      <Consumer />
    </ServerDataProvider>,
  );
  await screen.findByText("Tracking failed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(calls).toBe(1);
  fireEvent.click(screen.getByText("Retry tracking"));
  await screen.findByText("done");
  expect(calls).toBe(2);
  expect(
    cache.getQueryData(queryKeys.resource("two", "org_1", "run", "run_1")),
  ).toBeUndefined();
});
