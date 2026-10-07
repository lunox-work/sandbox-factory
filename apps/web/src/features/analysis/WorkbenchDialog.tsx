/**
 * A dialog drawn as the sandbox page's workbench is, always dark: a title
 * bar with its close button over its panes, a sidebar to move through what
 * it holds and the main view of the one open. What the repository page
 * reads its builds and its logs in.
 */

import { X, type LucideIcon } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export function WorkbenchDialog({
  title,
  detail,
  description,
  open,
  onOpenChange,
  notice,
  children,
}: {
  title: string;
  /** Beside the title, muted: a commit, a repository. */
  detail?: string | undefined;
  /** For assistive technology; not shown. */
  description: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Something that failed from inside it, such as a file that would not
   * open: said here, since the page's own banner is behind the dialog.
   */
  notice?: { text: string; onDismiss: () => void } | null | undefined;
  /** Its panes; mounted only while it is open, so each opening starts afresh. */
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Dimmed lightly and not blurred: the page behind is dark already,
        // and under the default wash it went black. A faint ring and a
        // shadow keep the dialog standing off it instead.
        overlayClassName="bg-black/20 backdrop-blur-none"
        className="workbench dark flex h-[min(85dvh,52rem)] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-clip rounded-lg border-(--wb-border) shadow-2xl ring-1 shadow-black/60 ring-white/5 p-0 text-[13px] sm:max-w-6xl sm:p-0"
      >
        <header className="flex h-[35px] shrink-0 items-center gap-2 border-b border-(--wb-border) bg-(--wb-chrome) pr-1 pl-3">
          <DialogTitle className="min-w-0 flex-1 truncate text-xs font-normal text-(--wb-foreground)">
            {title}
            {detail !== undefined && (
              <span className="text-(--wb-muted)"> · {detail}</span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
          <DialogClose
            aria-label="Close"
            title="Close"
            className="flex size-7 items-center justify-center rounded-[4px] text-(--wb-muted) hover:bg-(--wb-hover) hover:text-(--wb-strong) focus-visible:outline-1 focus-visible:outline-(--wb-accent)"
          >
            <X aria-hidden="true" className="size-4" />
          </DialogClose>
        </header>
        {notice != null && (
          <p
            role="alert"
            className="flex shrink-0 items-center gap-3 border-b border-(--wb-border) bg-red-950/40 px-3 py-1.5 text-xs text-red-200"
          >
            <span className="min-w-0 flex-1">{notice.text}</span>
            <button
              type="button"
              className="hover:text-(--wb-strong) hover:underline"
              onClick={notice.onDismiss}
            >
              Dismiss
            </button>
          </p>
        )}
        {open && children}
      </DialogContent>
    </Dialog>
  );
}

/** The sidebar, under its title, beside the main view. */
export function Panes({
  sidebarTitle,
  sidebar,
  children,
}: {
  sidebarTitle: string;
  sidebar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <aside
        aria-label={sidebarTitle}
        className="flex w-[40%] max-w-64 min-w-36 shrink-0 flex-col border-r border-(--wb-border) bg-(--wb-chrome)"
      >
        <h2 className="flex h-[35px] shrink-0 items-center px-5 text-[11px] font-normal tracking-wide uppercase">
          {sidebarTitle}
        </h2>
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col bg-(--wb-editor)">
        {children}
      </div>
    </div>
  );
}

/** The main view with nothing open: a faint mark, and a hint. */
export function Watermark({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 p-6 text-center text-sm text-(--wb-muted)">
      <Icon
        aria-hidden="true"
        className="size-24 opacity-15"
        strokeWidth={0.75}
      />
      <p>{children}</p>
    </div>
  );
}
