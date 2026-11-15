/**
 * The submission area: the contributor drops the project folder they
 * worked in, or its `.zip`, sees what it would submit (the API's dry run:
 * the files it changes, the guide and editor files left out, and every
 * file that stops it, by path), then submits it. A folder is zipped in the
 * browser first (`folder-zip.ts`), so the API compares one format with
 * the version, in one place.
 */

import { ApiError } from "@sandbox-factory/client";
import type {
  ContributionSubmissionDto,
  FolderPreviewDto,
} from "@sandbox-factory/shared";
import { FileArchive, FolderUp, Upload, X } from "lucide-react";
import { useId, useRef, useState, type DragEvent } from "react";

import { LoadingLine } from "@/components/Message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { clients } from "../../data/query";
import {
  droppedEntries,
  folderProblem,
  pickedEntries,
  zipEntries,
  type FolderEntry,
} from "./folder-zip";

type State =
  | { readonly step: "idle" }
  | { readonly step: "reading"; readonly name: string }
  | {
      readonly step: "preview";
      readonly name: string;
      readonly folder: Blob;
      readonly preview: FolderPreviewDto;
    }
  | {
      readonly step: "submitting";
      readonly name: string;
      readonly folder: Blob;
      readonly preview: FolderPreviewDto;
    }
  | {
      readonly step: "failed";
      readonly name: string | null;
      readonly error: string;
    };

const message = (failure: unknown) =>
  failure instanceof ApiError
    ? failure.message
    : "Could not reach the server. Try again.";

export function FolderUpload({
  versionId,
  retryOf,
  onSubmitted,
}: {
  versionId: string;
  /** The submission this one retries; undefined for the first. */
  retryOf?: string | undefined;
  onSubmitted: (submission: ContributionSubmissionDto) => void;
}) {
  const [state, setState] = useState<State>({ step: "idle" });
  const [over, setOver] = useState(false);
  const zipInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const hintId = useId();

  /** Checks an archive with the API, which stores nothing for it. */
  async function check(name: string, folder: Blob) {
    setState({ step: "reading", name });
    try {
      const preview = await clients.contributions.previewContributionFolder(
        versionId,
        folder,
        retryOf,
      );
      setState({ step: "preview", name, folder, preview });
    } catch (failure) {
      setState({ step: "failed", name, error: message(failure) });
    }
  }

  async function fromEntries(name: string, entries: FolderEntry[]) {
    const problem = folderProblem(entries);
    if (problem !== null) {
      setState({ step: "failed", name, error: problem });
      return;
    }
    setState({ step: "reading", name });
    await check(name, await zipEntries(entries));
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setOver(false);
    const item = event.dataTransfer.items?.[0];
    const entry = item?.webkitGetAsEntry?.() ?? null;
    if (entry?.isDirectory === true) {
      setState({ step: "reading", name: entry.name });
      try {
        await fromEntries(entry.name, await droppedEntries(entry));
      } catch {
        setState({
          step: "failed",
          name: entry.name,
          error: "The folder could not be read. Zip it and drop the .zip.",
        });
      }
      return;
    }
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void check(file.name, file);
  }

  async function submit() {
    if (state.step !== "preview") return;
    setState({ ...state, step: "submitting" });
    try {
      const submission = await clients.contributions.submitContributionFolder(
        versionId,
        state.folder,
        retryOf,
      );
      setState({ step: "idle" });
      onSubmitted(submission);
    } catch (failure) {
      setState({ step: "failed", name: state.name, error: message(failure) });
    }
  }

  const reset = () => setState({ step: "idle" });

  if (state.step === "preview" || state.step === "submitting")
    return (
      <Preview
        name={state.name}
        preview={state.preview}
        retry={retryOf !== undefined}
        submitting={state.step === "submitting"}
        onSubmit={() => void submit()}
        onReset={reset}
      />
    );

  return (
    <div className="flex flex-col gap-2">
      <div
        data-testid="folder-drop"
        aria-describedby={hintId}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => void onDrop(event)}
        className={cn(
          "flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center transition-colors",
          over ? "border-foreground/40 bg-accent/60" : "bg-muted/30",
        )}
      >
        {state.step === "reading" ? (
          <LoadingLine>Checking {state.name}…</LoadingLine>
        ) : (
          <>
            <span className="bg-background text-muted-foreground grid size-9 place-items-center rounded-md border">
              <FolderUp className="size-4" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-medium">
                {retryOf === undefined
                  ? "Drop your project folder or its .zip"
                  : "Drop the folder again for your retry"}
              </p>
              <p id={hintId} className="text-muted-foreground mt-1 text-xs">
                You will see what would be submitted before anything is sent.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => folderInput.current?.click()}
              >
                <FolderUp />
                Choose folder
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => zipInput.current?.click()}
              >
                <FileArchive />
                Choose .zip
              </Button>
            </div>
          </>
        )}
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          tabIndex={-1}
          aria-label="Project .zip"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) void check(file.name, file);
          }}
        />
        <input
          ref={folderInput}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-label="Project folder"
          // Not in React's types; every current browser reads it.
          {...{ webkitdirectory: "", directory: "" }}
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            const name =
              files[0]?.webkitRelativePath.split("/")[0] ?? "the folder";
            void fromEntries(name, pickedEntries(files));
          }}
        />
      </div>
      {state.step === "failed" && (
        <div
          role="alert"
          className="border-destructive/20 bg-destructive/5 text-destructive dark:bg-destructive/10 flex items-start justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-sm"
        >
          <span className="min-w-0 text-pretty">
            {state.name !== null && (
              <span className="font-medium">{state.name}: </span>
            )}
            {state.error}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={reset}
            className="text-destructive/80 hover:text-destructive shrink-0 rounded-sm"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/** What the folder would submit, and the one button that sends it. */
function Preview({
  name,
  preview,
  retry,
  submitting,
  onSubmit,
  onReset,
}: {
  name: string;
  preview: FolderPreviewDto;
  retry: boolean;
  submitting: boolean;
  onSubmit: () => void;
  onReset: () => void;
}) {
  const refused = preview.refused.length > 0;
  const nothing = preview.files.length === 0;
  const count = `${preview.files.length} ${preview.files.length === 1 ? "file" : "files"}`;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border"
      data-testid="folder-preview"
    >
      <div className="bg-muted/40 flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <FileArchive
            className="text-muted-foreground size-4 shrink-0"
            aria-hidden="true"
          />
          <span className="truncate font-medium">{name}</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={onReset}
          disabled={submitting}
        >
          Choose another
        </Button>
      </div>
      <div className="flex flex-col gap-4 px-4 py-4">
        {refused && (
          <div role="alert" className="flex flex-col gap-2">
            <p className="text-destructive text-sm font-medium">
              {preview.refused.length === 1
                ? "One file stops this folder from being submitted."
                : `${preview.refused.length} files stop this folder from being submitted.`}{" "}
              Revert or restore {preview.refused.length === 1 ? "it" : "them"}{" "}
              in your folder, then choose it again.
            </p>
            <ul className="flex flex-col gap-2">
              {preview.refused.map((refusal) => (
                <li
                  key={`${refusal.path}:${refusal.reason}`}
                  className="border-destructive/40 flex flex-col gap-0.5 border-l-2 pl-3 text-xs"
                >
                  <code className="text-foreground font-mono">
                    {refusal.path}
                  </code>
                  <span className="text-muted-foreground text-pretty">
                    {refusal.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            {nothing
              ? "No task file changed"
              : refused
                ? `Once fixed, it would submit ${count}`
                : `Submits ${count}`}
          </p>
          {nothing ? (
            <p className="text-muted-foreground text-xs">
              Edit the files the task lists, then choose the folder again.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {preview.files.map((file) => (
                <li
                  key={file.path}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <code className="min-w-0 truncate font-mono">
                    {file.path}
                  </code>
                  <Badge variant="outline" className="font-normal">
                    {file.change === "added" ? "Added" : "Changed"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(preview.ignored.length > 0 ||
          preview.skipped > 0 ||
          preview.missing.length > 0) && (
          <ul className="text-muted-foreground flex flex-col gap-1 border-t pt-3 text-xs">
            {preview.ignored.length > 0 && (
              <li>
                Left out, as guide and editor files:{" "}
                {preview.ignored.map((path, index) => (
                  <span key={path}>
                    {index > 0 && ", "}
                    <code className="font-mono">{path}</code>
                  </span>
                ))}
              </li>
            )}
            {preview.skipped > 0 && (
              <li>
                {preview.skipped} {preview.skipped === 1 ? "file" : "files"}{" "}
                skipped: installed packages, build output, version control and
                system files.
              </li>
            )}
            {preview.missing.length > 0 && (
              <li>
                Not in the folder, so the version&apos;s copy stands:{" "}
                {preview.missing.join(", ")}
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-4 py-2.5">
        <Button
          type="button"
          size="sm"
          disabled={refused || nothing || submitting}
          onClick={onSubmit}
        >
          <Upload />
          {submitting
            ? "Submitting…"
            : retry
              ? `Submit retry (${count})`
              : `Submit ${count}`}
        </Button>
      </div>
    </div>
  );
}
