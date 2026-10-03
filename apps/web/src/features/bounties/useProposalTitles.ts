import { useEffect, useState, useRef } from "react";
import { clients } from "../../data/query";
import { type EnrichedProposal, type ProposalTitle, titleLine } from "./types";
const TITLE_BATCH = 50;
export function useProposalTitles(
  boardPath: string | null,
  proposals: EnrichedProposal[],
) {
  const [titles, setTitles] = useState<Record<string, ProposalTitle>>({});
  const [titlesPending, setTitlesPending] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const titled = useRef(new Set<string>());
  const titleRequests = useRef(new Set<string>());
  const titleStreams = useRef(new Set<AbortController>());
  /** Bumped by `refresh`, so the open proposal is read again with the list. */

  useEffect(() => {
    // Only a board's rows are read live: a ticket's stored title is its own.
    if (boardPath === null) return;
    const untitled = proposals
      .map(({ id }) => id)
      .filter(
        (id) => !titled.current.has(id) && !titleRequests.current.has(id),
      );
    if (untitled.length === 0) return;
    for (const id of untitled) titleRequests.current.add(id);
    setTitlesPending((current) => new Set([...current, ...untitled]));
    for (let start = 0; start < untitled.length; start += TITLE_BATCH) {
      const wanted = untitled.slice(start, start + TITLE_BATCH);
      const controller = new AbortController();
      titleStreams.current.add(controller);
      const parts = boardPath.split("/");
      const owner = decodeURIComponent(parts[4] ?? "");
      const boardId = decodeURIComponent(parts.at(-1) ?? "");
      clients.pricing
        .titles(
          owner,
          boardId,
          wanted,
          (value) => {
            if (controller.signal.aborted) return;
            const title = titleLine(value);
            if (title === null) return;
            titled.current.add(title.id);
            setTitles((current) => ({ ...current, [title.id]: title }));
          },
          controller.signal,
        )
        .catch(() => {})
        .finally(() => {
          titleStreams.current.delete(controller);
          for (const id of wanted) titleRequests.current.delete(id);
          setTitlesPending(
            (current) =>
              new Set([...current].filter((id) => !wanted.includes(id))),
          );
        });
    }
  }, [boardPath, proposals]);

  // Streams still reading when the list goes away are stopped, so Jira is
  // not asked about rows nobody will see.
  useEffect(() => {
    const streams = titleStreams.current;
    const requests = titleRequests.current;
    return () => {
      for (const controller of streams) controller.abort();
      streams.clear();
      requests.clear();
    };
  }, []);
  return { titles, titlesPending };
}
