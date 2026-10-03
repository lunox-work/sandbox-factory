import type {
  BountyCategoryMatch,
  BountyProposalDto,
  BountyRunDto,
  BountyWritebackDto,
  ProposalCategoriesDto,
  ProposalLiveSpecDto,
  RateCardDto,
  StepResultDto,
} from "@sandbox-factory/shared";
import {
  DEFAULT_RATE_CARD,
  maximumRateCardMinor,
  formatMinorUnits,
  nextHalfStep,
  SCENARIO_WEIGHTS,
  UNCATEGORIZED,
  WEIGHT_POINTS,
  WHOLE_BOUNTY_COMPLEXITIES,
} from "sandbox-factory";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Layers,
  Loader2,
  Minus,
  Plus,
  Search,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorBanner, LoadingLine } from "@/components/Message";
import { PeekPanel } from "@/components/PeekPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RateSlider } from "@/components/RateSlider";
import { readNdjson } from "@/lib/ndjson";
import { parseRateAmount } from "@/lib/rate-amount";
import { CurrencySelect } from "@/components/CurrencySelect";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CategoryIcon } from "./CategoryIcon";
import {
  ComplexityProfileBlock,
  useProposalProfile,
} from "./ComplexityProfile";
import { IssueSpec, IssueSpecSkeleton } from "./IssueSpec";
import {
  plural,
  ProposalSpec,
  scenarioTotal,
  useProposalSpec,
  WeightBadge,
} from "./ProposalSpec";
import { JiraIcon, ModelIcon } from "./ProviderIcon";
import { useRespec } from "./SpecChanges";
import { TicketText } from "./TicketText";
import { useRepoSnapshot } from "./useGithub";
import type { JiraIssueDetail } from "./useJira";

type EnrichedProposal = BountyProposalDto & {
  /**
   * Why the run picked the ticket: each category it fit, with the reason.
   * Stored with the run like the title. Empty for a ticket someone added by
   * hand, and absent on a row read by id rather than from the list.
   */
  categories?: BountyCategoryMatch[];
  freshness?: "current" | "stale" | "missing" | "unknown";
  checkedAt?: string;
  code?: string;
  liveTitle?: string;
  liveKey?: string;
  liveUrl?: string;
  writebackOperations?: BountyWritebackDto[];
};

/** A line of the titles stream: a row's live title, or why it has none. */
type ProposalTitle =
  { id: string; key: string; title: string } | { id: string; code: string };

/** A titles-stream line, or null for one this page does not understand. */
function titleLine(value: unknown): ProposalTitle | null {
  if (typeof value !== "object" || value === null) return null;
  const line = value as Record<string, unknown>;
  const id = line["id"];
  if (typeof id !== "string") return null;
  const key = line["key"];
  const title = line["title"];
  if (typeof key === "string" && typeof title === "string") {
    return { id, key, title };
  }
  const code = line["code"];
  return typeof code === "string" ? { id, code } : null;
}

interface ProposalDetail {
  proposal: BountyProposalDto;
  freshness: {
    freshness: "current" | "stale" | "missing" | "unknown";
    checkedAt: string;
    code?: string;
  };
  /**
   * What the ticket says now: Jira's text for a ticket following an issue,
   * and the ticket as stored otherwise. Null when it could not be read.
   */
  liveSpec?: ProposalLiveSpecDto | null;
  writebackOperations: BountyWritebackDto[];
}

/**
 * How many proposals the list reads at a time. A run sizes every ticket
 * that fits a category, so a board can hold hundreds: the list shows this
 * many and offers the rest, rather than reading them all on every refresh.
 */
const PROPOSAL_PAGE = 50;

/** The most ids one titles stream may ask for; the route refuses more. */
const TITLE_BATCH = 50;

/**
 * Why a ticket was picked, on one line: one category and its reason, and
 * how many more it fits. The peek lists them all.
 *
 * `lead` is the category the list is narrowed to, if any. A ticket in two
 * categories leads with that one, so every row under "Deadline exposed"
 * says its deadline rather than whichever reason happened to come first.
 */
function CategoryLine({
  categories,
  lead,
  wrapOnPhone = false,
}: {
  categories: readonly BountyCategoryMatch[] | undefined;
  lead?: string | null;
  /**
   * Let the line wrap below the `sm` breakpoint. A proposal row stacks on a
   * phone and its title wraps, so a reason cut to "Deadline exposed ·…"
   * beside it would drop the one part worth reading.
   */
  wrapOnPhone?: boolean;
}) {
  const all = categories ?? [];
  const first = all.find(({ id }) => id === lead) ?? all[0];
  if (first === undefined) return null;
  const rest = all.filter((category) => category !== first);
  return (
    <span
      className={`text-muted-foreground block text-xs ${wrapOnPhone ? "sm:truncate" : "truncate"}`}
      data-testid="category-line"
      title={(categories ?? [])
        .map(({ label, reason }) => `${label}: ${reason}`)
        .join("\n")}
    >
      <span className="text-foreground/80 font-medium">
        {/* At the text's own size, and dropped a hair to sit on its line. */}
        <CategoryIcon
          category={first.id}
          className="mr-1 inline-block size-3 align-[-0.125em]"
        />
        {first.label}
      </span>
      {" · "}
      {first.reason}
      {rest.length > 0 && ` · +${rest.length} more`}
    </span>
  );
}

/** `?category=` as the page will use it: a category id, or none. */
function categoryFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("category");
  // The same shape the API accepts. Anything else is not a category, and
  // sending it on would turn a mistyped link into a failed list.
  return value !== null && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)
    ? value
    : null;
}

/**
 * A board's category summary, or null for a body that is not one: the view
 * is drawn only from a response it can read in full.
 */
function categorySummary(value: unknown): ProposalCategoriesDto | null {
  if (typeof value !== "object" || value === null) return null;
  const { total, uncategorized, categories } = value as Record<string, unknown>;
  if (
    typeof total !== "number" ||
    typeof uncategorized !== "number" ||
    !Array.isArray(categories)
  )
    return null;
  const usable = categories.every(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)["id"] === "string" &&
      typeof (entry as Record<string, unknown>)["label"] === "string" &&
      typeof (entry as Record<string, unknown>)["count"] === "number",
  );
  return usable ? (value as ProposalCategoriesDto) : null;
}

/**
 * One way into the list: every proposal, one category's, or the ones in no
 * category.
 */
function CategoryTile({
  label,
  count,
  icon,
  pressed,
  disabled = false,
  hint,
  onPress,
}: {
  label: string;
  count: number;
  /** Decoration: the label names the tile, so the icon is not read aloud. */
  icon: ReactElement;
  pressed: boolean;
  disabled?: boolean;
  hint?: string;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      // Said in reading order. The tile shows the number first because that
      // is what the eye is scanning for, which reads aloud as "7 Left behind".
      aria-label={`${label}, ${count} ${count === 1 ? "proposal" : "proposals"}`}
      disabled={disabled}
      title={hint}
      onClick={onPress}
      className={`focus-visible:ring-ring/50 flex h-full w-full flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 ${
        pressed ? "bg-muted border-foreground/30" : "hover:bg-muted/50"
      }`}
    >
      {/*
        The count where the eye lands, and the icon across from it: what
        tells one tile from the next before either label is read.
      */}
      <span className="flex w-full items-start justify-between gap-2">
        <span className="text-lg leading-none font-semibold tabular-nums">
          {count}
        </span>
        <span
          className={`shrink-0 [&>svg]:size-4 ${pressed ? "text-foreground" : "text-muted-foreground"}`}
        >
          {icon}
        </span>
      </span>
      <span
        className={`text-xs leading-tight ${pressed ? "text-foreground font-medium" : "text-muted-foreground"}`}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * The board's proposals by the reason each ticket was picked, above the
 * list they narrow.
 *
 * A run takes a ticket because it fits a category, so the categories are
 * the natural way to walk what a run produced: all the blockers, then all
 * the paper cuts. Each tile says how many the board has and, pressed, makes
 * the list below show those. The six are always the same six in the same
 * order, a category with nothing in it shown but not pressable, so a tile
 * does not move when a count reaches zero.
 *
 * After them, the tickets no run picked for a reason, which would
 * otherwise be reachable only by reading the whole list for the rows with
 * nothing under their title. It is the one tile the page names itself: it
 * is not in the registry the other six come from.
 *
 * A ticket picked for two categories is counted in both, which is why the
 * tiles can sum past "All".
 */
function CategoryNav({
  summary,
  selected,
  onSelect,
}: {
  summary: ProposalCategoriesDto;
  selected: string | null;
  onSelect: (category: string | null) => void;
}) {
  const tiles = [
    ...summary.categories,
    {
      id: UNCATEGORIZED,
      label: "Uncategorized",
      why: "Picked by hand, or sized before there were categories.",
      count: summary.uncategorized,
    },
  ];
  const active = tiles.find(({ id }) => id === selected);
  return (
    <nav
      aria-label="Proposals by category"
      className="flex flex-col gap-2"
      data-testid="category-nav"
    >
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        <li>
          <CategoryTile
            label="All"
            count={summary.total}
            // Not a category, so not one of their icons: the whole pile.
            icon={<Layers aria-hidden="true" focusable="false" />}
            pressed={selected === null}
            onPress={() => onSelect(null)}
          />
        </li>
        {tiles.map((category) => (
          <li key={category.id}>
            <CategoryTile
              label={category.label}
              count={category.count}
              icon={
                category.id === UNCATEGORIZED ? (
                  // No category, so no category's icon: an empty outline.
                  <CircleDashed aria-hidden="true" focusable="false" />
                ) : (
                  <CategoryIcon category={category.id} />
                )
              }
              pressed={selected === category.id}
              // An empty category is nowhere to go — unless it is the one
              // being shown, which must stay pressable to be left.
              disabled={category.count === 0 && selected !== category.id}
              hint={category.why}
              onPress={() =>
                onSelect(selected === category.id ? null : category.id)
              }
            />
          </li>
        ))}
      </ul>
      {/* What the chosen category is for, where a tooltip would hide it. */}
      {active !== undefined && active.why !== "" && (
        <p className="text-muted-foreground text-xs" data-testid="category-why">
          <span className="text-foreground font-medium">{active.label}.</span>{" "}
          {active.why}
        </p>
      )}
    </nav>
  );
}

function canManage(role: string): boolean {
  return role
    .split(",")
    .some((entry) => ["owner", "admin"].includes(entry.trim()));
}

function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function editableRateAmount(minor: number, digits: number): string {
  // Drop only an all-zero fraction from stored amounts. Legacy fractional
  // rates stay visible and must be corrected before the form can be saved.
  return (formatMinorUnits(minor, digits) ?? "").replace(/\.0+$/, "");
}

const MODEL_VENDORS: Record<string, string> = {
  claude: "Claude",
  deepseek: "DeepSeek",
};

/**
 * A readable name for a provider model id, e.g. `claude-sonnet-5` →
 * "Claude Sonnet 5", `deepseek-v4-pro` → "DeepSeek V4 Pro". Adjacent numeric
 * segments are a version (`4-6` → "4.6"); an eight-digit segment is a
 * snapshot date and is dropped. Unknown vendors are capitalised as-is, so a
 * new provider still reads as a name rather than an id. `null` when the
 * proposal carries no model.
 */
export function modelLabel(id: string | null | undefined): string | null {
  if (id === undefined || id === null || id.trim() === "") return null;
  const words: string[] = [];
  for (const segment of id.trim().split("-")) {
    if (segment === "") continue;
    if (/^\d{8}$/.test(segment)) continue;
    if (/^\d+$/.test(segment) && /^\d+(\.\d+)*$/.test(words.at(-1) ?? "")) {
      words[words.length - 1] = `${words.at(-1)}.${segment}`;
      continue;
    }
    words.push(
      MODEL_VENDORS[segment.toLowerCase()] ??
        segment[0]!.toUpperCase() + segment.slice(1),
    );
  }
  return words.length === 0 ? null : words.join(" ");
}

export function money(
  amountMinor: number | null,
  currency: string | null,
): string {
  if (amountMinor === null || currency === null) return "Unpriced";
  const digits = fractionDigits(currency);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

type RateDraft = Pick<
  RateCardDto,
  "currency" | "xsMinor" | "sMinor" | "mMinor" | "lMinor" | "xlMinor"
>;

function rateDraft(
  currency: string,
  values: Record<string, string>,
): RateDraft | null {
  const digits = fractionDigits(currency);
  const [xsMinor = 0, sMinor = 0, mMinor = 0, lMinor = 0, xlMinor = 0] = [
    "XS",
    "S",
    "M",
    "L",
    "XL",
  ].map((size) => parseRateAmount(values[size] ?? "", digits) ?? 0);
  if (
    xsMinor <= 0 ||
    sMinor < xsMinor ||
    mMinor < sMinor ||
    lMinor < mMinor ||
    xlMinor < lMinor
  )
    return null;
  return { currency, xsMinor, sMinor, mMinor, lMinor, xlMinor };
}

function sameRates(left: RateDraft, right: RateDraft | null): boolean {
  return (
    right !== null &&
    left.currency === right.currency &&
    left.xsMinor === right.xsMinor &&
    left.sMinor === right.sMinor &&
    left.mMinor === right.mMinor &&
    left.lMinor === right.lMinor &&
    left.xlMinor === right.xlMinor
  );
}

// The card the API saves on an organization's first run, so what the editor
// shows before anyone edits it is what that run prices with.
const DEFAULT_RATE_AMOUNTS = {
  XS: editableRateAmount(DEFAULT_RATE_CARD.xsMinor, 2),
  S: editableRateAmount(DEFAULT_RATE_CARD.sMinor, 2),
  M: editableRateAmount(DEFAULT_RATE_CARD.mMinor, 2),
  L: editableRateAmount(DEFAULT_RATE_CARD.lMinor, 2),
  XL: editableRateAmount(DEFAULT_RATE_CARD.xlMinor, 2),
};

const RATE_SAVE_STATUSES = {
  saving: "Saving…",
  failed: "Changes not saved.",
  saved: "Saved",
  incomplete: "Set XS and XL to save your rates.",
  automatic: "Changes save automatically.",
} as const;

export function RateCardEditor({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const [card, setCard] = useState<RateCardDto | null>(null);
  const [currency, setCurrency] = useState("USD");
  const [values, setValues] =
    useState<Record<string, string>>(DEFAULT_RATE_AMOUNTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedCard = useRef<RateCardDto | null>(null);
  const pending = useRef<RateDraft | null>(null);
  const writing = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    pending.current = null;
    writing.current = false;
    setSaving(false);
    setShowSaved(false);
    setLoading(true);
    setLoadFailed(false);
    setSaveFailed(false);
    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error();
      const next = ((await response.json()) as { rateCard: RateCardDto | null })
        .rateCard;
      if (request !== generation.current) return false;
      savedCard.current = next;
      setCard(next);
      setCurrency(next?.currency ?? "USD");
      const digits = fractionDigits(next?.currency ?? "USD");
      setValues(
        next === null
          ? { ...DEFAULT_RATE_AMOUNTS }
          : {
              XS: editableRateAmount(next.xsMinor, digits),
              S: editableRateAmount(next.sMinor, digits),
              M: editableRateAmount(next.mMinor, digits),
              L: editableRateAmount(next.lMinor, digits),
              XL: editableRateAmount(next.xlMinor, digits),
            },
      );
      setError(null);
      return true;
    } catch {
      if (request === generation.current) {
        setError("Could not load the rate card.");
        setLoadFailed(true);
      }
      return false;
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      pending.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!showSaved) return;
    const timer = window.setTimeout(() => setShowSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [showSaved, card]);

  async function save(
    nextCurrency: string,
    nextValues: Record<string, string>,
  ) {
    if (!canManage(role) || loading || loadFailed) return;
    const draft = rateDraft(nextCurrency, nextValues);
    if (draft === null) {
      // A new card needs both endpoints before there is a complete rate range.
      if (nextValues.XS && nextValues.XL) {
        setError(
          `Enter positive whole-number ${nextCurrency} amounts in increasing order. Decimals are not supported.`,
        );
      }
      return;
    }
    if (draft.xlMinor > maximumRateCardMinor(nextCurrency)) {
      setError("XL cannot exceed USD 1,000.");
      return;
    }
    pending.current = draft;
    if (writing.current) return;
    const request = generation.current;
    writing.current = true;
    setSaving(true);
    setShowSaved(false);
    setError(null);
    setSaveFailed(false);
    let wrote = false;
    try {
      while (pending.current !== null && request === generation.current) {
        const next = pending.current;
        pending.current = null;
        if (sameRates(next, savedCard.current)) continue;
        const response = await fetch(
          `/api/v1/orgs/${encodeURIComponent(organizationId)}/rate-card`,
          {
            method: "PUT",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expectedRevision: savedCard.current?.revision ?? 0,
              ...next,
            }),
          },
        );
        const body = (await response.json()) as {
          rateCard?: RateCardDto;
          error?: string;
        };
        if (request !== generation.current) return;
        if (!response.ok || body.rateCard === undefined) {
          pending.current = null;
          if (response.status === 409) {
            const reloaded = await load();
            if (reloaded)
              setError(
                "The rate card changed elsewhere. The latest rates have been reloaded.",
              );
          } else {
            setError(body.error ?? "Could not save the rate card.");
            setSaveFailed(true);
          }
          return;
        }
        savedCard.current = body.rateCard;
        setCard(body.rateCard);
        wrote = true;
      }
      if (wrote && request === generation.current) setShowSaved(true);
    } catch {
      if (request === generation.current) {
        pending.current = null;
        setError("Could not save changes. Check your connection and retry.");
        setSaveFailed(true);
      }
    } finally {
      if (request === generation.current) {
        writing.current = false;
        setSaving(false);
      }
    }
  }

  const draft = rateDraft(currency, values);
  const saved = draft !== null && sameRates(draft, card);
  const saveStatus = saving
    ? "saving"
    : saveFailed
      ? "failed"
      : saved
        ? showSaved
          ? "saved"
          : null
        : !values.XS || !values.XL
          ? "incomplete"
          : "automatic";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bounty rate card</CardTitle>
        <CardDescription>
          Prices used by future runs and re-pricing. Existing proposals keep
          their saved price.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingLine />
        ) : (
          <div className="flex flex-col gap-4">
            {error !== null && (
              <ErrorBanner className="mt-0">
                {error}
                {(loadFailed || saveFailed) && (
                  <button
                    type="button"
                    disabled={saving}
                    className="ml-2 font-medium underline underline-offset-2 disabled:opacity-50"
                    onClick={() => {
                      if (loadFailed) void load();
                      else void save(currency, values);
                    }}
                  >
                    Retry
                  </button>
                )}
              </ErrorBanner>
            )}
            <CurrencySelect
              value={currency}
              disabled={!canManage(role) || loadFailed}
              onValueChange={(next) => {
                setCurrency(next);
                void save(next, values);
              }}
            />
            <RateSlider
              currency={currency}
              digits={fractionDigits(currency)}
              values={values}
              onValueChange={setValues}
              onValueCommit={(next) => {
                void save(currency, next);
              }}
              disabled={!canManage(role) || loadFailed}
            />
            {canManage(role) && (
              <div className="text-muted-foreground relative min-h-4 text-right text-xs">
                <span
                  role="status"
                  aria-label="Rate card save status"
                  aria-atomic="true"
                  className="sr-only"
                >
                  {saveStatus === null ? "" : RATE_SAVE_STATUSES[saveStatus]}
                </span>
                {Object.entries(RATE_SAVE_STATUSES).map(([state, label]) => (
                  <span
                    key={state}
                    aria-hidden="true"
                    data-save-state={state}
                    data-active={state === saveStatus}
                    className="rate-save-message"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Proposals, and the peek a reviewer decides them in: one board's, or with
 * no board the organization's, from every source — Jira's tickets and the
 * ones written here alike.
 *
 * A board's list has the board's machinery around it: its sizing run as it
 * streams, the search for one of its tickets to add, and each row's live
 * title from Jira. The organization's list reads stored rows only, since a
 * ticket's title is stored with it, and each proposal's freshness comes
 * from its own read as on a board.
 */
export function BoardBounties({
  organizationId,
  boardId,
  role,
  writeGranted = true,
  readIssue,
  emptyText,
}: {
  organizationId: string;
  /** The board whose proposals these are; absent, the organization's. */
  boardId?: string | undefined;
  role: string;
  /**
   * Whether this board's site holds the write grant. Shown, not switched:
   * the permission is asked for when a site is connected, and a site
   * without it is connected again from the Jira page to grant it.
   */
  writeGranted?: boolean | undefined;
  /**
   * Reads one ticket live from Jira, for the peek's Spec tab. Passed in
   * rather than fetched here because the board page owns the Jira read and
   * the reconnect banner that answers its failures. Absent, the tab shows
   * the ticket as the proposal's own read returned it.
   */
  readIssue?:
    ((issueKey: string) => Promise<JiraIssueDetail | null>) | undefined;
  /** What an empty list says, in place of the board's wording. */
  emptyText?: string | undefined;
}) {
  const [runs, setRuns] = useState<BountyRunDto[]>([]);
  const [proposals, setProposals] = useState<EnrichedProposal[]>([]);
  /*
    How many rows the list is holding open, and whether the board has more.
    A ref for the count: a refresh re-reads that many, and "Show more"
    raises it, so a decision made with three pages open does not fold the
    list back to one.
  */
  const wantedRows = useRef(PROPOSAL_PAGE);
  const [moreProposals, setMoreProposals] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /*
    The category the list is narrowed to, if any, and the board's counts per
    category. `?category=` like `?proposal=`: a view can be linked, and Back
    returns to the one before. `switching` is the moment between pressing a
    tile and its rows landing, when the rows on screen are the last view's.
  */
  const [category, setCategory] = useState<string | null>(categoryFromUrl);
  const [categories, setCategories] = useState<ProposalCategoriesDto | null>(
    null,
  );
  const [switching, setSwitching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("proposal"),
  );
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  /*
    The open proposal's detail read finished with nothing to show. Keyed by
    id, so a read for one proposal never speaks for the next; without it a
    stale shared link leaves the peek on its loading line for good.
  */
  const [detailFailure, setDetailFailure] = useState<{
    id: string;
    notFound: boolean;
  } | null>(null);
  const [sizingAvailable, setSizingAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  /*
    The ticket behind the open proposal, read live for the Spec tab.

    Read when the peek opens rather than when the tab is pressed, so the
    switch to Spec is instant. `wantedKey` is what stops a slow read for one
    ticket landing in a peek that has since moved to another — or closed:
    neither `ticket` nor the selection can be read inside the resolve, both
    are stale by then, so the check is against what was last asked for.
  */
  const [ticket, setTicket] = useState<JiraIssueDetail | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const wantedKey = useRef<string | null>(null);

  /*
    Live titles, by proposal id, as the titles stream reports them. Kept
    across list refreshes, so a refresh asks Jira only about rows it has not
    titled yet: after an approval or a landed run result, usually none or
    one. `titleRequests` holds the ids a stream is out for, so a row is never
    asked for twice at once; `titlesPending` is the same set as state, for
    the placeholder.

    `titled` repeats the map's keys in a ref, and is what decides whether
    to ask. An effect can run after the stream that answered a row has
    already let go of it, while its render's `titles` predates that
    answer; checked against state, the row would be asked for again.
  */
  const [titles, setTitles] = useState<Record<string, ProposalTitle>>({});
  const [titlesPending, setTitlesPending] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const titled = useRef(new Set<string>());
  const titleRequests = useRef(new Set<string>());
  const titleStreams = useRef(new Set<AbortController>());
  /** Bumped by `refresh`, so the open proposal is read again with the list. */
  const [detailVersion, setDetailVersion] = useState(0);

  const base = `/api/v1/orgs/${encodeURIComponent(organizationId)}`;
  const boardPath =
    boardId === undefined
      ? null
      : `${base}/jira/boards/${encodeURIComponent(boardId)}`;
  /*
    Runs and stored proposals: both local reads, so the list renders as soon
    as they land. Nothing here waits on Jira — titles stream in below, and
    the open proposal's freshness comes from its own read — and nothing here
    depends on which proposal is open, so opening one does not re-read it.
  */
  const loadList = useCallback(async () => {
    const generation = ++requestGeneration.current;
    // Page after page until the list holds as many rows as it has open, or
    // the board runs out. Each page is one local read.
    const readProposals = async () => {
      const rows: EnrichedProposal[] = [];
      let cursor: string | null = null;
      do {
        const response: Response = await fetch(
          `${base}/proposals?${
            boardId === undefined
              ? ""
              : `boardId=${encodeURIComponent(boardId)}&`
          }limit=${PROPOSAL_PAGE}${
            category === null ? "" : `&category=${encodeURIComponent(category)}`
          }${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
          { credentials: "include" },
        );
        if (!response.ok) throw new Error();
        const body = (await response.json()) as {
          proposals?: EnrichedProposal[];
          nextCursor?: string | null;
        };
        rows.push(...(body.proposals ?? []));
        cursor = body.nextCursor ?? null;
      } while (cursor !== null && rows.length < wantedRows.current);
      return { rows, more: cursor !== null };
    };
    // The counts behind the category view, re-read with the list so a
    // decision or a landed result moves both together. Optional: a board
    // whose counts cannot be read still lists its proposals, without the
    // view.
    const readCategories = async () => {
      try {
        const response = await fetch(
          `${boardPath ?? base}/proposal-categories`,
          { credentials: "include" },
        );
        return response.ok ? categorySummary(await response.json()) : null;
      } catch {
        return null;
      }
    };
    // A board's runs, for its sizing stream and whether it can be sized.
    // The organization's list has no board run to show.
    const readRuns = async () => {
      if (boardPath === null) return { runs: [], sizingAvailable: true };
      const response = await fetch(`${boardPath}/runs`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error();
      return (await response.json()) as {
        runs: BountyRunDto[];
        sizingAvailable: boolean;
      };
    };
    try {
      const [runBody, listed, summary] = await Promise.all([
        readRuns(),
        readProposals(),
        readCategories(),
      ]);
      if (generation !== requestGeneration.current) return;
      setRuns(runBody.runs ?? []);
      setSizingAvailable(runBody.sizingAvailable);
      setProposals(listed.rows);
      setMoreProposals(listed.more);
      setCategories(summary);
      setError(null);
    } catch {
      if (generation === requestGeneration.current)
        setError("Could not load bounty runs and proposals.");
    } finally {
      if (generation === requestGeneration.current) {
        setLoading(false);
        setSwitching(false);
      }
    }
  }, [base, boardId, boardPath, category]);

  /*
    What a mutation, a landed run result or a search re-reads: the list, and
    the open proposal with it, since either may have changed under it.
  */
  const refresh = useCallback(async () => {
    setDetailVersion((version) => version + 1);
    await loadList();
  }, [loadList]);

  /** Another page of rows, kept open across the refreshes that follow. */
  const showMore = useCallback(async () => {
    wantedRows.current += PROPOSAL_PAGE;
    setLoadingMore(true);
    try {
      await loadList();
    } finally {
      setLoadingMore(false);
    }
  }, [loadList]);

  /*
    The list is emptied and shown loading only when what it lists changes —
    the board. A refresh must not blank it: the row that was pressed is what
    the peek returns focus to, and a list that unmounts under an open peek
    takes the row with it.
  */
  useEffect(() => {
    setLoading(true);
    setProposals([]);
    setMoreProposals(false);
    setCategories(null);
    wantedRows.current = PROPOSAL_PAGE;
  }, [boardId]);
  /*
    A category is a different list, so it starts at one page. Unlike a board
    change it does not blank the page: the tiles are what was just pressed,
    and the rows stay, dimmed, until the category's own arrive.
  */
  useEffect(() => {
    wantedRows.current = PROPOSAL_PAGE;
  }, [category]);
  useEffect(() => {
    void loadList();
    return () => {
      requestGeneration.current += 1;
    };
  }, [loadList]);

  /*
    The open proposal, read on its own. Its freshness is checked against
    Jira, which is why it is not part of the list: one ticket's read, when
    somebody opens it, rather than every ticket's on every list read.
  */
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      setDetailFailure(null);
      return;
    }
    let live = true;
    const failed = (notFound: boolean) => {
      if (!live) return;
      setDetail(null);
      setDetailFailure({ id: selectedId, notFound });
    };
    fetch(
      `${base}/proposals/${encodeURIComponent(selectedId)}${
        boardId === undefined ? "" : `?boardId=${encodeURIComponent(boardId)}`
      }`,
      { credentials: "include" },
    )
      .then(async (response) => {
        if (!response.ok) return failed(response.status === 404);
        const body = (await response.json()) as ProposalDetail;
        if (!live) return;
        setDetail(body);
        setDetailFailure(null);
      })
      .catch(() => failed(false));
    return () => {
      live = false;
    };
  }, [base, boardId, selectedId, detailVersion]);

  /*
    Titles for the rows that have none yet. Each row fills in as its line
    arrives rather than when the slowest ticket answers. A row the stream
    ended without is left untitled and unrecorded, so the next refresh asks
    for it again.

    One stream for all of them, up to what the route accepts in one request;
    a list holding more untitled rows than that opens a stream per batch.
  */
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
      fetch(
        `${boardPath}/proposal-titles?ids=${wanted.map(encodeURIComponent).join(",")}`,
        { credentials: "include", signal: controller.signal },
      )
        .then((response) =>
          response.ok && response.body !== null
            ? readNdjson(response.body, (value) => {
                const title = titleLine(value);
                if (title === null) return;
                titled.current.add(title.id);
                setTitles((current) => ({ ...current, [title.id]: title }));
              })
            : undefined,
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
  // The board's own sizing run. A one-ticket run someone added is followed
  // by the search or the ticket that started it, and a change to one
  // proposal's spec by the proposal's peek: none is the board's stream.
  const active = runs.find(
    (run) =>
      run.kind !== "issue" &&
      run.kind !== "respec" &&
      run.kind !== "ticket" &&
      (run.status === "queued" || run.status === "running"),
  );
  /*
    While a run is active, the run alone is polled, every second: it is one
    local read, and it carries the plan and each result as it lands. The
    full re-read — which checks every proposal against Jira — runs only when
    a result has landed or the run has ended, so the list catches up
    without Jira being asked about the whole board every second.
  */
  const activeId = active?.id;
  const seenOutcomes = useRef(active?.outcomes.length ?? 0);
  useEffect(() => {
    if (activeId === undefined) return;
    let live = true;
    const timer = window.setInterval(() => {
      void fetch(`${base}/runs/${encodeURIComponent(activeId)}`, {
        credentials: "include",
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ run: BountyRunDto }>)
            : null,
        )
        .then((body) => {
          if (!live || body === null) return;
          const run = body.run;
          setRuns((current) =>
            current.map((row) => (row.id === run.id ? run : row)),
          );
          const ended = run.status !== "queued" && run.status !== "running";
          if (ended || run.outcomes.length !== seenOutcomes.current) {
            seenOutcomes.current = run.outcomes.length;
            void refresh();
          }
        })
        .catch(() => {});
    }, 1_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [activeId, base, refresh]);

  /*
    `?proposal=<id>` is the open peek, so a reload or a shared link lands on
    the same proposal, and the browser's back button closes it — the same
    contract the backlog peek had with `?issue`.
  */
  const openProposal = useCallback((proposalId: string) => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("proposal") !== proposalId) {
      params.set("proposal", proposalId);
      window.history.pushState(
        null,
        "",
        `${window.location.pathname}?${params.toString()}`,
      );
    }
    setSelectedId(proposalId);
  }, []);

  // A proposal the ticket search produced: the list re-read so it has the
  // row, then opened. Stable, because the search follows a run with it.
  const showProposal = useCallback(
    async (proposalId: string) => {
      await refresh();
      openProposal(proposalId);
    },
    [refresh, openProposal],
  );

  const closeProposal = useCallback((updateUrl: boolean) => {
    setSelectedId(null);
    if (updateUrl) {
      const params = new URLSearchParams(window.location.search);
      if (params.has("proposal")) {
        params.delete("proposal");
        const query = params.toString();
        window.history.pushState(
          null,
          "",
          window.location.pathname + (query === "" ? "" : `?${query}`),
        );
      }
    }
  }, []);

  /** Narrow the list to one category, or to none. */
  const selectCategory = useCallback((next: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if ((params.get("category") ?? null) === next) return;
    if (next === null) params.delete("category");
    else params.set("category", next);
    const query = params.toString();
    window.history.pushState(
      null,
      "",
      window.location.pathname + (query === "" ? "" : `?${query}`),
    );
    setSwitching(true);
    setCategory(next);
  }, []);

  useEffect(() => {
    const sync = () => {
      const next = new URLSearchParams(window.location.search).get("proposal");
      if (next === null || next === "") closeProposal(false);
      else setSelectedId(next);
      // Back and forward move between category views too.
      setCategory(categoryFromUrl());
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [closeProposal]);

  const detailProposal: EnrichedProposal | null =
    detail === null
      ? null
      : {
          ...detail.proposal,
          ...detail.freshness,
          writebackOperations: detail.writebackOperations,
        };
  const visibleProposals =
    detailProposal === null ||
    proposals.some(({ id }) => id === detailProposal.id)
      ? proposals
      : [detailProposal, ...proposals];
  /*
    A row's key and title: live once its line has arrived, and until then
    the title the platform holds for the ticket. The two are nearly always
    the same words, so most rows never change.
  */
  const nameOf = (proposal: EnrichedProposal) => {
    const live = titles[proposal.id];
    return {
      key:
        (live !== undefined && "key" in live ? live.key : undefined) ??
        proposal.liveKey ??
        proposal.issueKey,
      title:
        (live !== undefined && "title" in live ? live.title : undefined) ??
        proposal.liveTitle ??
        (proposal.title === "" ? undefined : proposal.title),
      pending: titlesPending.has(proposal.id),
    };
  };
  const selectedRow =
    selectedId === null
      ? null
      : (visibleProposals.find(({ id }) => id === selectedId) ?? null);
  /*
    The open proposal: its stored row, with what only its detail knows —
    freshness, the live title, delivery — laid over it once that arrives.
    The row stays the word on stored fields, as it was before the detail
    was read separately. Freshness is only ever the detail's, so until it
    lands the peek says Jira is being checked, and a failed read says it
    was not.
  */
  const selectedView: EnrichedProposal | null =
    selectedRow === null
      ? null
      : detail !== null && detail.proposal.id === selectedRow.id
        ? {
            ...selectedRow,
            ...detail.freshness,
            writebackOperations: detail.writebackOperations,
          }
        : detailFailure !== null && detailFailure.id === selectedRow.id
          ? { ...selectedRow, freshness: "unknown" }
          : selectedRow;
  const selectedName = selectedView === null ? null : nameOf(selectedView);
  const selected: EnrichedProposal | null =
    selectedView === null || selectedName === null
      ? null
      : {
          ...selectedView,
          liveKey: selectedName.key,
          ...(selectedName.title === undefined
            ? {}
            : { liveTitle: selectedName.title }),
        };
  const selectedKey = selectedName === null ? null : selectedName.key;

  const loadTicket = useCallback(
    (issueKey: string) => {
      if (readIssue === undefined) return;
      wantedKey.current = issueKey;
      setTicket(null);
      setTicketError(null);
      void readIssue(issueKey).then((result) => {
        if (wantedKey.current !== issueKey) return;
        if (result !== null) setTicket(result);
        else setTicketError("Could not load this ticket from Jira.");
      });
    },
    [readIssue],
  );
  useEffect(() => {
    if (selectedKey === null) {
      wantedKey.current = null;
      setTicket(null);
      setTicketError(null);
      return;
    }
    loadTicket(selectedKey);
  }, [selectedKey, loadTicket]);

  /**
   * One POST, then the page catches up.
   *
   * By default that is a full re-read — runs, list and detail — because an
   * approval or a re-price changes more than the row: the run list, the
   * Jira delivery, the ticket's freshness. A mutation that returns the
   * proposal it changed and touches nothing else can `apply` it instead:
   * the row and the open detail take the proposal from the response, and
   * no request follows. That is what keeps a resize instant, where the
   * re-read would check the open proposal against Jira again.
   */
  async function mutate(
    path: string,
    body: object,
    { apply = false }: { apply?: boolean } = {},
  ): Promise<boolean> {
    setBusy(true);
    try {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = (await response.json().catch(() => ({}))) as {
        error?: string;
        proposal?: BountyProposalDto;
      };
      if (!response.ok) {
        setError(value.error ?? "That action could not be completed.");
        return false;
      }
      setError(null);
      const changed = value.proposal;
      if (apply && changed !== undefined) {
        setProposals((current) =>
          current.map((row) =>
            row.id === changed.id ? { ...row, ...changed } : row,
          ),
        );
        setDetail((current) =>
          current === null || current.proposal.id !== changed.id
            ? current
            : { ...current, proposal: changed },
        );
        return true;
      }
      await refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingLine>Loading proposals…</LoadingLine>;

  return (
    <div className="flex flex-col gap-4">
      {error !== null && <ErrorBanner className="mt-0">{error}</ErrorBanner>}

      {canManage(role) && sizingAvailable && boardId !== undefined && (
        <TicketSearch base={base} boardId={boardId} onProposal={showProposal} />
      )}

      {/*
        Connecting a site sizes its boards on its own, so the first visit
        usually lands mid-run. Said here, above a list that fills as the
        poll brings proposals in.
      */}
      {active !== undefined && (
        <SizingStream
          run={active}
          proposals={visibleProposals}
          onOpen={openProposal}
        />
      )}

      {/* A warning only when there is something to warn about. */}
      {(!sizingAvailable || !writeGranted) && (
        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          {!sizingAvailable && (
            <p>Sizing is not configured for this deployment.</p>
          )}
          {!writeGranted && (
            <p
              className="text-amber-700 dark:text-amber-400"
              data-testid="jira-writeback"
            >
              Approvals stay here: this site was connected without write access.
              Connect it again from the Jira page to grant it.
            </p>
          )}
        </div>
      )}

      {/*
        The categories, over the list they narrow. Absent on a board with no
        proposals, where a row of zeros would say nothing. If the counts could
        not be read while a link has the list narrowed, the narrowing still
        has to be visible and undoable, so it is said in a line instead.
      */}
      {categories !== null && categories.total > 0 ? (
        <CategoryNav
          summary={categories}
          selected={category}
          onSelect={selectCategory}
        />
      ) : (
        category !== null && (
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            Showing one category.
            <button
              type="button"
              className="text-foreground underline underline-offset-2"
              onClick={() => selectCategory(null)}
            >
              Show all
            </button>
          </p>
        )
      )}

      {/*
        The list at full width, with the proposal opening over it rather than
        beside it or inside it. See `PeekPanel` for why. A row carries only
        what a scan needs — which ticket, at what size, for how much — and
        everything a decision needs is in the peek.
      */}
      <div
        aria-busy={switching}
        className={`overflow-hidden rounded-lg border transition-opacity ${switching ? "opacity-60" : ""}`}
      >
        {visibleProposals.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {category !== null
              ? "No proposals in this category."
              : active === undefined
                ? (emptyText ?? "No proposals yet.")
                : "Proposals appear here as tickets are sized."}
          </p>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="text-muted-foreground bg-muted/40 hidden items-center gap-3 border-b px-3 py-2 text-xs font-medium sm:flex"
            >
              <span className="w-20 shrink-0">Ticket</span>
              <span className="flex-1" />
              <span className="w-24 shrink-0">Status</span>
              <span className="w-12 shrink-0">Size</span>
              <span className="w-24 shrink-0 text-right">Amount</span>
              <span className="size-4 shrink-0" />
            </div>
            <ul className="divide-y" data-testid="proposal-list">
              {visibleProposals.map((proposal) => {
                const name = nameOf(proposal);
                return (
                  <li key={proposal.id}>
                    <button
                      type="button"
                      aria-current={
                        selectedId === proposal.id ? "true" : undefined
                      }
                      className={`hover:bg-muted/50 grid w-full grid-cols-[1fr_auto_1rem] items-center gap-x-3 gap-y-1 px-3 py-3 text-left transition-colors sm:flex sm:py-2.5 ${
                        selectedId === proposal.id ? "bg-muted" : ""
                      }`}
                      onClick={() => openProposal(proposal.id)}
                    >
                      <span className="flex min-w-0 flex-col sm:contents">
                        <span className="text-muted-foreground shrink-0 font-mono text-xs sm:w-20">
                          {name.key}
                        </span>
                        {/*
                          The title, and under it why the run picked the
                          ticket: that is what makes a row more than an old
                          ticket with a price, so it is on the row rather
                          than only in the peek.
                        */}
                        <span className="flex min-w-0 flex-col sm:flex-1">
                          <span className="min-w-0 text-sm sm:truncate">
                            {name.title ??
                              (name.pending ? (
                                // Held open at a title's width, so the row
                                // does not reflow when its line arrives.
                                <span
                                  aria-hidden="true"
                                  data-testid="title-pending"
                                  className="skeleton inline-block h-3 w-40 max-w-full rounded align-middle"
                                />
                              ) : (
                                "Ticket"
                              ))}
                          </span>
                          <CategoryLine
                            categories={proposal.categories}
                            lead={category}
                            wrapOnPhone
                          />
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3 sm:contents">
                        <span className="sm:w-24 sm:shrink-0">
                          <Badge
                            variant={
                              proposal.status === "approved"
                                ? "default"
                                : "secondary"
                            }
                          >
                            {capitalize(proposal.status)}
                          </Badge>
                        </span>
                        <span className="sm:w-12 sm:shrink-0">
                          {/*
                            A dashed size is one with no weighed spec
                            behind it: sized before weights, or with no
                            draft at all. Re-analyzing weighs it, which a
                            reviewer finds these rows to do.
                          */}
                          {unweighed(proposal) ? (
                            <Badge
                              variant="outline"
                              className="border-dashed font-mono"
                              title="No weighed scenarios: re-analyze to weigh them"
                              data-unweighed=""
                            >
                              {proposal.complexity}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="font-mono">
                              {proposal.complexity}
                            </Badge>
                          )}
                        </span>
                        <span className="text-sm tabular-nums sm:w-24 sm:shrink-0 sm:text-right">
                          {money(proposal.amountMinor, proposal.currency)}
                        </span>
                      </span>
                      <ChevronRight className="text-muted-foreground size-4 shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
            {moreProposals && (
              <div className="flex justify-center border-t px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={() => void showMore()}
                >
                  {loadingMore && <Loader2 className="animate-spin" />}
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/*
        Mounted whether or not a proposal is open, so Radix can animate it
        out on close. The actions live in the Bounty card, each beside the
        fact it changes; the card is short, so nothing pushes them off.
      */}
      <PeekPanel
        open={selectedId !== null}
        onOpenChange={(next: boolean) => {
          if (!next) closeProposal(true);
        }}
        title={selected?.liveTitle ?? "Proposal"}
        description={selected?.liveKey ?? selected?.issueKey ?? undefined}
        data-testid="proposal-panel"
      >
        {selected === null ? (
          detailFailure !== null && detailFailure.id === selectedId ? (
            detailFailure.notFound ? (
              <p className="text-muted-foreground text-sm">
                {boardId === undefined
                  ? "This proposal no longer exists."
                  : "This proposal is not on this board."}
              </p>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <ErrorBanner className="mt-0">
                  Could not load the proposal.
                </ErrorBanner>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                >
                  <RefreshCw />
                  Try again
                </Button>
              </div>
            )
          ) : (
            <LoadingLine>Loading the proposal…</LoadingLine>
          )
        ) : (
          <ProposalPeek
            base={base}
            proposal={selected}
            ticket={readIssue === undefined ? null : ticket}
            liveSpec={
              readIssue === undefined &&
              detail !== null &&
              detail.proposal.id === selected.id
                ? (detail.liveSpec ?? null)
                : undefined
            }
            ticketError={readIssue === undefined ? null : ticketError}
            onRetryTicket={() => {
              if (selectedKey !== null) loadTicket(selectedKey);
            }}
            canDecide={canManage(role)}
            busy={busy}
            mutate={mutate}
            onChanged={refresh}
            onRemoved={() => closeProposal(true)}
          />
        )}
      </PeekPanel>
    </div>
  );
}

/** What the freshness check found, said plainly rather than as a code. */
function freshnessLabel(freshness: EnrichedProposal["freshness"]): {
  text: string;
  tone: "muted" | "warn" | "bad";
} {
  switch (freshness) {
    case "current":
      return { text: "Unchanged since sizing", tone: "muted" };
    case "stale":
      return { text: "Changed since sizing", tone: "warn" };
    case "missing":
      return { text: "Ticket no longer exists", tone: "bad" };
    // Not known yet: the open proposal's own read is still out.
    case undefined:
      return { text: "Checking the ticket…", tone: "muted" };
    default:
      return { text: "Not checked", tone: "muted" };
  }
}

interface TicketResult {
  id: string;
  key: string;
  summary: string;
  status: string;
  issueType: string;
  /** How many sub-tasks it is split into. Absent from an older API. */
  subtaskCount?: number;
}

/**
 * Whether a found ticket can be sized. One split into sub-tasks is priced
 * through them, never itself, so it is listed, to say why, but not offered.
 */
function addable(ticket: TicketResult): boolean {
  return (ticket.subtaskCount ?? 0) === 0;
}

/**
 * Find a ticket on the board and size it now.
 *
 * For the ticket the automatic run did not pick — too new, assigned, past
 * the board's limit — or one somebody wants priced before anything else.
 * The search reads the board live from Jira and lists only tickets not yet
 * on the platform — one with a proposal is already in the list below.
 * Picking one starts a run for that ticket alone, follows it, and opens the
 * proposal the moment it lands. A ticket split into sub-tasks is shown but
 * cannot be picked: its sub-tasks are what is sized.
 */
function TicketSearch({
  base,
  boardId,
  onProposal,
}: {
  base: string;
  boardId: string;
  onProposal: (proposalId: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TicketResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState<{
    key: string;
    summary: string;
    runId: string;
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const boardPath = `${base}/jira/boards/${encodeURIComponent(boardId)}`;

  /*
    Searched as the person types, a quarter-second after they stop. The
    generation check drops an answer that arrives after a newer query was
    sent, so a slow search cannot overwrite a faster later one.
  */
  const generation = useRef(0);
  useEffect(() => {
    const request = ++generation.current;
    if (query.trim() === "") {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void fetch(`${boardPath}/search?q=${encodeURIComponent(query.trim())}`, {
        credentials: "include",
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as {
            issues?: TicketResult[];
            error?: string;
          };
          if (request !== generation.current) return;
          setResults(response.ok ? (body.issues ?? []) : []);
          setMessage(
            response.ok ? null : (body.error ?? "Could not search Jira."),
          );
        })
        .catch(() => {
          if (request === generation.current)
            setMessage("Could not reach the server.");
        })
        .finally(() => {
          if (request === generation.current) setSearching(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [boardPath, query]);

  /*
    The added ticket's run, followed until it has an answer: its proposal
    opens as soon as it exists. A run that ends without one either lost a
    race to another run that proposed the same ticket — whose proposal is
    then the one to open — or could not size it, which is said here.
  */
  useEffect(() => {
    if (pending === null) return;
    let live = true;
    const timer = window.setInterval(() => {
      void fetch(`${base}/runs/${encodeURIComponent(pending.runId)}`, {
        credentials: "include",
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ run: BountyRunDto }>)
            : null,
        )
        .then(async (body) => {
          if (!live || body === null) return;
          const { run } = body;
          const outcome = run.outcomes[0];
          const ended = run.status !== "queued" && run.status !== "running";
          if (outcome?.proposalId !== undefined) {
            live = false;
            setPending(null);
            await onProposal(outcome.proposalId);
            return;
          }
          if (!ended) return;
          live = false;
          setPending(null);
          if (outcome?.code === "live_proposal") {
            // Proposed by the board's own run in the meantime. The search
            // no longer lists it, so its proposal is found in the board's.
            const listed = await fetch(
              `${base}/proposals?boardId=${encodeURIComponent(boardId)}`,
              { credentials: "include" },
            );
            const found = listed.ok
              ? (
                  (await listed.json()) as { proposals: BountyProposalDto[] }
                ).proposals.find(({ issueKey }) => issueKey === pending.key)
              : undefined;
            if (found !== undefined) {
              await onProposal(found.id);
              return;
            }
          }
          setMessage(`Could not size ${pending.key}.`);
        })
        .catch(() => {});
    }, 1_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [base, boardId, onProposal, pending]);

  async function pick(ticket: TicketResult) {
    setMessage(null);
    try {
      const response = await fetch(`${boardPath}/issues`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          issueId: ticket.id,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        run?: BountyRunDto;
        proposalId?: string;
        error?: string;
      };
      if (!response.ok) {
        setMessage(body.error ?? `Could not add ${ticket.key}.`);
        return;
      }
      setQuery("");
      if (body.proposalId !== undefined) {
        await onProposal(body.proposalId);
      } else if (body.run !== undefined) {
        setPending({
          key: ticket.key,
          summary: ticket.summary,
          runId: body.run.id,
        });
      }
    } catch {
      setMessage("Could not reach the server.");
    }
  }

  return (
    <div className="relative flex flex-col gap-2">
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Find a ticket to size"
          placeholder="Find a ticket to size — key or words from its title"
          className="pl-9"
          value={query}
          disabled={pending !== null}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            const first = results?.find(addable);
            if (event.key === "Enter" && first !== undefined) {
              event.preventDefault();
              void pick(first);
            }
          }}
        />
      </div>

      {query.trim() !== "" && (
        <div
          className="bg-popover absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border shadow-md"
          data-testid="ticket-results"
        >
          {searching && results === null ? (
            <p className="text-muted-foreground flex items-center gap-2 px-3 py-2.5 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Searching…
            </p>
          ) : results !== null && results.length === 0 ? (
            <p className="text-muted-foreground px-3 py-2.5 text-sm">
              No tickets to add match — tickets already proposed are in the list
              below.
            </p>
          ) : (
            <ul className="divide-y">
              {(results ?? []).map((ticket) => (
                <li key={ticket.id}>
                  <button
                    type="button"
                    className="hover:bg-muted/50 flex w-full items-center gap-3 px-3 py-2 text-left text-sm disabled:pointer-events-none disabled:opacity-60"
                    disabled={!addable(ticket)}
                    onClick={() => void pick(ticket)}
                  >
                    <span className="w-20 shrink-0 font-mono text-xs">
                      {ticket.key}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {ticket.summary}
                    </span>
                    <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                      {ticket.status}
                    </span>
                    {addable(ticket) ? (
                      <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
                        <Plus className="size-3.5" />
                        Add
                      </span>
                    ) : (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {plural(ticket.subtaskCount ?? 0, "sub-task")}: size
                        those
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending !== null && (
        <p
          className="text-muted-foreground flex items-center gap-2 text-sm"
          role="status"
        >
          <Loader2 className="size-4 animate-spin" />
          Sizing <span className="font-mono text-xs">{pending.key}</span>
          <span className="truncate">{pending.summary}</span>…
        </p>
      )}
      {message !== null && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/** How many tickets the executor sizes at once. Mirrors the API's own. */
const SIZING_CONCURRENCY = 3;

/**
 * A run in flight, ticket by ticket.
 *
 * Connecting a site sizes its boards in the background, so a board is often
 * opened mid-run. This is what the run is doing: the tickets it picked, the
 * ones it has finished — with the size and amount as they land — the ones
 * being sized now, and the ones still waiting. The page polls every second
 * while a run is active, so rows turn over as the model answers.
 *
 * Which tickets are "sizing now" is inferred, not reported: the executor
 * takes the plan in order, a few at a time, so the first few without a
 * result are the ones in the model's hands.
 */
function SizingStream({
  run,
  proposals,
  onOpen,
}: {
  run: BountyRunDto;
  proposals: EnrichedProposal[];
  onOpen: (proposalId: string) => void;
}) {
  const done = new Map(run.outcomes.map((o) => [o.externalIssueId, o]));
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const total = run.planned.length;
  let inFlight = 0;

  return (
    <section
      aria-label="Sizing in progress"
      className="overflow-hidden rounded-lg border"
      data-testid="sizing-active"
    >
      <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
        <Loader2 className="text-muted-foreground size-4 animate-spin" />
        {total === 0 ? (
          <span>Picking tickets from the board…</span>
        ) : (
          <span>
            Sizing {total} ticket{total === 1 ? "" : "s"}
            <span className="text-muted-foreground"> · {done.size} done</span>
          </span>
        )}
      </div>
      {total > 0 && (
        <>
          <div
            className="bg-muted h-0.5"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done.size}
          >
            <div
              className="bg-primary h-full transition-[width] duration-500 ease-out"
              style={{ width: `${(done.size / total) * 100}%` }}
            />
          </div>
          {/*
            Scrolls within itself: a run sizes every ticket that fits a
            category, and a plan of hundreds must not push the proposals
            it is producing off the page.
          */}
          <ul className="max-h-96 divide-y overflow-y-auto text-sm">
            {run.planned.map((ticket) => {
              const outcome = done.get(ticket.externalIssueId);
              const proposal =
                outcome?.proposalId === undefined
                  ? undefined
                  : byId.get(outcome.proposalId);
              const sizing =
                outcome === undefined && inFlight++ < SIZING_CONCURRENCY;
              return (
                <li
                  key={ticket.externalIssueId}
                  className="flex items-center gap-3 px-3 py-2"
                  data-state={
                    outcome !== undefined
                      ? "done"
                      : sizing
                        ? "sizing"
                        : "queued"
                  }
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {outcome === undefined ? (
                      sizing ? (
                        <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                      ) : (
                        <Circle className="text-muted-foreground/50 size-3" />
                      )
                    ) : outcome.status === "failed" ? (
                      <CircleX className="size-4 text-red-600 dark:text-red-400" />
                    ) : (
                      <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
                    )}
                  </span>
                  <span className="w-20 shrink-0 font-mono text-xs">
                    {ticket.issueKey}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={`truncate ${outcome === undefined && !sizing ? "text-muted-foreground" : ""}`}
                    >
                      {ticket.summary}
                    </span>
                    <CategoryLine categories={ticket.categories} />
                  </span>
                  {proposal !== undefined ? (
                    <button
                      type="button"
                      className="flex shrink-0 items-center gap-2 animate-in fade-in"
                      onClick={() => onOpen(proposal.id)}
                    >
                      <Badge variant="outline" className="font-mono">
                        {proposal.complexity}
                      </Badge>
                      <span className="w-20 text-right tabular-nums">
                        {money(proposal.amountMinor, proposal.currency)}
                      </span>
                    </button>
                  ) : outcome !== undefined ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {capitalize(outcome.status)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The sizing model's confidence as a mark and a colour: up, level, or down. */
const CONFIDENCE_MARK: Record<
  BountyProposalDto["modelConfidence"],
  { icon: ReactElement; tone: string }
> = {
  high: { icon: <ChevronUp strokeWidth={2.5} />, tone: "text-emerald-500" },
  medium: { icon: <Minus strokeWidth={2.5} />, tone: "text-muted-foreground" },
  low: { icon: <ChevronDown strokeWidth={2.5} />, tone: "text-red-500" },
};

function capitalize(value: string): string {
  return value === "" ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * A size with no step behind it: its spec was drafted before scenarios
 * were weighed, or it has none. A scenario added later cannot move it until
 * the proposal is re-analyzed. An unsized proposal has no size to move.
 */
function unweighed(proposal: Pick<BountyProposalDto, "complexity" | "step">) {
  // `?? null`: a row from an API that predates steps carries none at all.
  return proposal.complexity !== "unsized" && (proposal.step ?? null) === null;
}

/**
 * The open proposal, in three tabs.
 *
 * Bounty is the decision — one card of what the proposal is, with each
 * action beside the fact it changes (for those who may act), the model's
 * reasoning as prose, and where delivery to Jira stands. Scenarios is what
 * the ticket was taken to ask for when it was sized, with the count in the
 * tab once it is known. Spec is the ticket itself, read live, so the
 * decision is made against what Jira says now rather than what was stored
 * at sizing time.
 *
 * Two states. Proposed: Re-analyze (the re-price) beside the status, the
 * resize as the size itself level with the amount, and Approve after the
 * reasoning with Remove under it. Approved: Re-analyze beside the status
 * and Unapprove after the reasoning —
 * removal comes after unapproving, because that is what owes Jira the
 * withdrawal. Approve needs a current ticket; a resize, a re-price and an
 * unapprove do not.
 */
function ProposalPeek({
  base,
  proposal,
  ticket,
  liveSpec,
  ticketError,
  onRetryTicket,
  canDecide,
  busy,
  mutate,
  onChanged,
  onRemoved,
}: {
  /** The organization's API root, for the reads the peek makes itself. */
  base: string;
  proposal: EnrichedProposal;
  ticket: JiraIssueDetail | null;
  /**
   * The ticket as the proposal's own read returned it, for a list with no
   * Jira read of its own: undefined until that read lands, and null when it
   * found nothing to show.
   */
  liveSpec?: ProposalLiveSpecDto | null | undefined;
  ticketError: string | null;
  onRetryTicket: () => void;
  canDecide: boolean;
  busy: boolean;
  mutate: (
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => Promise<boolean>;
  /** Reads the proposal again, after a change to its spec has landed. */
  onChanged: () => Promise<void>;
  onRemoved: () => void;
}) {
  const url = ticket?.url ?? proposal.liveUrl ?? null;
  const label = modelLabel(proposal.actualModel);
  const delivery = proposal.writebackOperations?.at(-1);
  const freshness = freshnessLabel(proposal.freshness);
  const priced = proposal.amountMinor !== null;
  const open = proposal.status === "proposed";
  const key = proposal.liveKey ?? proposal.issueKey;
  // Read when the peek opens, like the ticket, so the tab opens on it.
  const spec = useProposalSpec(base, proposal.id, proposal.specRevision);
  // The commit the spec's repository outline came from, when it had one.
  const outline = useRepoSnapshot(base, proposal.repoSnapshotId ?? null);
  // What the size will point back to, measured from that repository.
  const profile = useProposalProfile(
    base,
    proposal.id,
    proposal.specRevision,
    proposal.repoSnapshotId != null,
  );
  const scenarios = scenarioTotal(spec.read);
  const step = proposal.step ?? null;
  // A reviewer's changes to the spec, and the run each one starts.
  const respec = useRespec(base, proposal.id, proposal.revision, onChanged);
  // What a change moves is the step, so a proposal without one has nothing
  // to change; an approved one is unapproved first.
  const canChange =
    canDecide &&
    open &&
    step !== null &&
    (proposal.specRevision ?? null) !== null;
  // The size a resize replaces: the step's base when there is a step, so a
  // reviewer sees which whole size the half size stands on.
  const sizeBase = step?.base ?? proposal.complexity;
  // The model pill and the XL warning drop a row when the notes are shown.
  const lowerRow =
    proposal.sizedBy === "reviewer" ? "sm:row-start-3" : "sm:row-start-2";
  return (
    <div className="flex flex-col gap-5" data-testid="proposal-detail">
      {/*
        The tab strip and the way out to Jira share a row: both are controls
        on this proposal, and the right edge is where this app puts the
        action a surface offers.
      */}
      <Tabs defaultValue="bounty">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="bounty">Bounty</TabsTrigger>
            <TabsTrigger value="scenarios">
              Scenarios
              {scenarios !== null && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {scenarios}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="spec">Spec</TabsTrigger>
          </TabsList>
          {url !== null && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              asChild
            >
              <a href={url} target="_blank" rel="noreferrer noopener">
                <span className="size-3.5 shrink-0">
                  <JiraIcon />
                </span>
                Open in Jira
                <ExternalLink className="size-3" />
              </a>
            </Button>
          )}
        </div>

        <TabsContent value="bounty" className="mt-2">
          <div className="flex flex-col gap-6" data-testid="proposal-bounty">
            {/*
              The proposal as one card: the status with the way to have
              the model look again, then the amount level with the size
              that sets it. The amount is the one number a reviewer is
              here to agree to, so it is the one thing set large.
            */}
            <div className="flex flex-col gap-4 rounded-lg border p-4 sm:p-5">
              {/* The state, and the way to have the model look again. */}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <Badge variant="secondary" className="w-fit">
                  {capitalize(proposal.status)}
                </Badge>
                {canDecide && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex cursor-pointer items-center gap-1.5 rounded-sm text-sm underline-offset-4 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/proposals/${proposal.id}/reprice`, {
                        expectedRevision: proposal.revision,
                        requestId: crypto.randomUUID(),
                      })
                    }
                  >
                    <RefreshCw className="size-3.5" />
                    Re-analyze
                  </button>
                )}
              </div>

              {/*
                The amount level with the size that sets it, and the
                sizing model level with the one warning a size can
                carry: a two-by-two grid, each row centred on itself.
                When a reviewer has overruled the model, a row of notes
                sits between the two — what the model said on the left,
                under the amount, and who set the size on the right,
                under the size — one row, so the two are level whatever
                the heights above them. On a phone it stacks in reading
                order instead, the notes still sharing their line.
              */}
              <div className="grid grid-cols-1 items-center gap-x-6 gap-y-2.5 sm:grid-cols-[1fr_auto]">
                <span
                  className={`text-3xl leading-none font-semibold tracking-tight sm:col-start-1 sm:row-start-1 ${
                    priced ? "tabular-nums" : "text-muted-foreground"
                  }`}
                >
                  {money(proposal.amountMinor, proposal.currency)}
                </span>
                {/* Who sized it, as a pill wearing the vendor's mark. */}
                <span
                  className={`inline-flex w-fit items-center gap-1.5 rounded-full border py-1 pr-2.5 pl-2 text-xs sm:col-start-1 ${lowerRow}`}
                >
                  <span className="flex size-3.5 shrink-0 items-center [&>svg]:size-3.5">
                    <ModelIcon model={proposal.actualModel} />
                  </span>
                  {label === null ? (
                    <span className="font-medium">{proposal.actualModel}</span>
                  ) : (
                    <span className="font-medium" title={proposal.actualModel}>
                      {label}
                    </span>
                  )}
                  {/*
                      The model's confidence as a mark: up in green, level
                      in neutral, down in red. Named for assistive
                      technology and on hover, since a shape and a colour
                      alone say nothing to a screen reader.
                    */}
                  <span
                    role="img"
                    aria-label={`${proposal.modelConfidence} confidence`}
                    title={`${proposal.modelConfidence} confidence`}
                    className={`flex shrink-0 items-center [&>svg]:size-3.5 ${CONFIDENCE_MARK[proposal.modelConfidence].tone}`}
                  >
                    {CONFIDENCE_MARK[proposal.modelConfidence].icon}
                  </span>
                </span>
                <div className="sm:col-start-2 sm:row-start-1 sm:justify-self-end">
                  {canDecide && open ? (
                    /*
                      The size is the resize: a row of cards, one per size,
                      with the current size drawn as the larger one. That
                      card is disabled, since it is not a change, but kept
                      solid rather than faded — it is the fact being shown.

                      Five cards, one per whole size. A half size is where
                      the scenario step lands, never a reviewer's choice,
                      so it has no card of its own: it is shown on the
                      card of the whole size below it, which reads "S+"
                      while it is the size in force. A reviewer sets the
                      whole size the step stands on.
                    */
                    <div
                      role="group"
                      aria-label="Resize"
                      className="flex min-h-12 flex-wrap items-center gap-1.5 sm:justify-end"
                    >
                      {proposal.complexity === "unsized" && (
                        <SizeCard size="unsized" current />
                      )}
                      {WHOLE_BOUNTY_COMPLEXITIES.map((size) => {
                        const current =
                          proposal.complexity === size ||
                          proposal.complexity === `${size}+`;
                        const isBase = sizeBase === size;
                        return (
                          <SizeCard
                            key={size}
                            size={current ? proposal.complexity : size}
                            current={current}
                            pressed={isBase}
                            disabled={busy || isBase}
                            onClick={() =>
                              void mutate(
                                `/proposals/${proposal.id}/resize`,
                                {
                                  expectedRevision: proposal.revision,
                                  complexity: size,
                                },
                                { apply: true },
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <SizeCard size={proposal.complexity} current />
                  )}
                </div>
                {proposal.sizedBy === "reviewer" && (
                  <div className="text-muted-foreground flex items-baseline justify-between gap-x-6 text-xs sm:col-span-2 sm:row-start-2">
                    <span>the model said {proposal.modelComplexity}</span>
                    <span className="text-right">
                      {step !== null && step.steps > 0
                        ? `${step.base} set by a reviewer`
                        : "set by a reviewer"}
                    </span>
                  </div>
                )}
                {/*
                  The one warning a size can carry, level with the model
                  and under the size it is about: an XL is a hint that
                  the ticket is two.
                */}
                {proposal.complexity === "XL" && (
                  <span
                    className={`flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400 sm:col-start-2 sm:justify-self-end ${lowerRow}`}
                  >
                    <TriangleAlert className="size-3.5 shrink-0" />
                    Consider splitting
                  </span>
                )}
              </div>
            </div>

            {/*
              Why the run offered this ticket at all, before why it is the
              size it is: the first is the case for outsourcing it, the
              second for the price. Absent for a ticket someone added by
              hand, which needs no case made.
            */}
            {proposal.categories !== undefined &&
              proposal.categories.length > 0 && (
                <div data-testid="proposal-categories">
                  <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                    Why this ticket
                  </p>
                  <ul className="flex flex-col gap-1.5">
                    {proposal.categories.map((category) => (
                      <li
                        key={category.id}
                        className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
                      >
                        <Badge variant="outline" className="shrink-0">
                          <CategoryIcon category={category.id} />
                          {category.label}
                        </Badge>
                        <span className="leading-relaxed">
                          {category.reason}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

            {/*
              Why this size, in two parts: what the model made of the
              ticket, and then what the spec's added weight made of that.
            */}
            <div>
              <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                Why this size
              </p>
              <p className="text-sm leading-relaxed">
                {proposal.modelRationale}
              </p>
              {canDecide && unweighed(proposal) && (
                <p
                  className="text-muted-foreground mt-1.5 text-xs"
                  data-testid="proposal-unweighed"
                >
                  This size has no weighed scenarios, so a scenario added later
                  cannot move it. Re-analyze drafts and weighs them.
                </p>
              )}
            </div>

            {step !== null && <StepBlock step={step} />}

            <ComplexityProfileBlock
              read={profile}
              specRevision={proposal.specRevision}
            />

            {/* A rule before the decision: what follows is the act, not the record. */}
            <Separator />

            {/*
              The decision row, after the reasoning it is made on. On the
              left, what the decision is checked against: which revision
              this is, and under it whether the ticket still says what it
              said when sized. On the right, the decision itself — Approve for a
              proposed bounty, the way back for an approved one — where
              this app puts the action a surface offers, and centred under
              Approve, the way out: a muted text link rather than a button,
              since it is the least-wanted action on the page and should
              read as such; the confirmation is where it turns red. The left text is given the button's height so the two
              sit level whether or not Remove hangs below.
            */}
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <span className="flex h-9 flex-col justify-center text-xs">
                <span className="font-semibold">
                  Revision {proposal.revision}
                </span>
                <span
                  className={
                    freshness.tone === "warn"
                      ? "text-amber-700 dark:text-amber-400"
                      : freshness.tone === "bad"
                        ? "text-destructive"
                        : "text-muted-foreground"
                  }
                >
                  {freshness.text}
                </span>
              </span>
              {canDecide &&
                (open ? (
                  proposal.complexity !== "unsized" && (
                    <div className="flex flex-col items-center gap-1.5">
                      <Button
                        disabled={busy || proposal.freshness !== "current"}
                        onClick={() =>
                          void mutate(`/proposals/${proposal.id}/approve`, {
                            expectedRevision: proposal.revision,
                          })
                        }
                      >
                        Approve
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-xs underline-offset-2 transition-colors hover:underline focus-visible:ring-[3px] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                            disabled={busy}
                          >
                            Remove
                          </button>
                        }
                        title={`Remove the proposal for ${key}?`}
                        description="The ticket will have no proposal, and the next sizing run may propose it again. Nothing is posted to Jira."
                        confirmLabel="Remove"
                        tone="destructive"
                        busy={busy}
                        onConfirm={async () => {
                          const removed = await mutate(
                            `/proposals/${proposal.id}/remove`,
                            { expectedRevision: proposal.revision },
                          );
                          if (removed) onRemoved();
                        }}
                      />
                    </div>
                  )
                ) : (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate(`/proposals/${proposal.id}/unapprove`, {
                        expectedRevision: proposal.revision,
                      })
                    }
                  >
                    Unapprove
                  </Button>
                ))}
            </div>

            {delivery !== undefined && (
              <div>
                <p className="text-muted-foreground mb-1.5 text-xs font-medium">
                  Jira
                </p>
                <DeliveryStatus
                  operation={delivery}
                  busy={busy}
                  mutate={mutate}
                />
              </div>
            )}
          </div>
        </TabsContent>

        {/*
          What the ticket was taken to ask for when it was sized: after the
          decision, which it supports, and before the ticket it was drafted
          from.
        */}
        <TabsContent value="scenarios" className="mt-2">
          <ProposalSpec
            read={spec.read}
            onRetry={spec.retry}
            canAnalyze={canDecide}
            weightPoints={step?.settings.weightPoints ?? WEIGHT_POINTS}
            sizeReason={{
              modelSize: proposal.modelComplexity,
              rationale: proposal.modelRationale,
              // The size the reviewer chose: the step's base when the
              // spec's added weight has moved it on since.
              reviewerSize: proposal.sizedBy === "reviewer" ? sizeBase : null,
              outline:
                outline === null
                  ? null
                  : {
                      repoFullName: outline.repoFullName,
                      commitSha: outline.commitSha,
                    },
            }}
            history={{
              base,
              proposalId: proposal.id,
              specRevision: proposal.specRevision ?? null,
            }}
            {...(canChange
              ? { changes: { control: respec, size: proposal.complexity } }
              : {})}
          />
        </TabsContent>

        <TabsContent value="spec" className="mt-2">
          {liveSpec === null ? (
            <p className="text-muted-foreground py-6 text-sm">
              The ticket could not be read.
            </p>
          ) : liveSpec !== undefined ? (
            <TicketText
              issueType={liveSpec.issueType}
              description={liveSpec.descriptionText}
              inputTruncated={liveSpec.inputTruncated}
            />
          ) : ticketError !== null ? (
            <div className="flex min-h-48 flex-col items-start justify-center gap-3">
              <ErrorBanner className="mt-0">{ticketError}</ErrorBanner>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryTicket}
              >
                <RefreshCw />
                Try again
              </Button>
            </div>
          ) : ticket === null ? (
            <IssueSpecSkeleton />
          ) : (
            <IssueSpec issue={ticket} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * How the weight added to the spec since it was sized moved the size: the
 * half steps it climbed, the points behind them and what the next half
 * step needs, then the scenarios that brought the points. Nothing when no
 * weight was added, which is every fresh sizing.
 */
function StepBlock({ step }: { step: StepResultDto }) {
  if (step.addedPoints === 0) return null;
  const next = nextHalfStep(step.complexity);
  // Heaviest first: the scenarios that moved the size most lead.
  const tally = [...SCENARIO_WEIGHTS].reverse().flatMap((weight) => {
    const count = step.added.filter((added) => added.weight === weight).length;
    return count === 0 ? [] : [`${count} ${weight}`];
  });
  return (
    <div data-testid="proposal-step">
      <p className="text-muted-foreground mb-1.5 text-xs font-medium">
        Added to the spec
      </p>
      <p className="text-sm leading-relaxed">
        {step.steps > 0 && (
          <span className="font-mono font-medium">
            {step.base} → {step.complexity}:{" "}
          </span>
        )}
        {plural(step.addedPoints, "point")} added since it was sized
        {tally.length > 0 && ` (${tally.join(", ")})`}.
        {next !== null &&
          step.nextStepIn !== null &&
          ` ${next} needs ${step.nextStepIn} more.`}
      </p>
      {step.added.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {step.added.map((scenario) => (
            <li
              key={scenario.id}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 leading-relaxed">
                {scenario.title}
              </span>
              <span className="flex shrink-0 self-center">
                <WeightBadge
                  weight={scenario.weight}
                  points={step.settings.weightPoints[scenario.weight]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One size as a card. The current size is the larger card, drawn solid; the
 * others are small and quiet, and become buttons when `onClick` is given.
 * Without it the card is a plain label, which is what a member or an
 * approved proposal sees: the size, without the offer to change it.
 *
 * A resize does not swap elements, it swaps classes on the same cards
 * once the server answers, so the change is animated rather than snapped:
 * the old size shrinks and fades to quiet while the new one grows and
 * fills, on one eased curve. Everything that differs between the two
 * shapes is in the transition list, so nothing jumps while the rest glides.
 * Off under reduced motion.
 *
 * Three things would make that bumpy, and each is kept out on purpose:
 *
 * - The width is never set, only the minimum. A set width lands on its new
 *   value at once while the minimum is still easing, so a growing card
 *   would pop wide and then finish growing. With only the minimum in play
 *   the box follows the ease in both directions, and "unsized" is free to
 *   be wider than it is tall.
 * - The other cards keep their look while the request is in flight. They
 *   are disabled, so a second click cannot race the first, but they are not
 *   dimmed and still answer the pointer: a dim would flash across the row
 *   on every click, and dropping the hover would make the pressed card
 *   fall back to quiet before it fills.
 * - The row is as tall as the large card whatever is mid-flight. Halfway
 *   through, the old card has shrunk and the new one has not yet grown,
 *   and without a floor the row would dip and lift the amount beside it.
 */
function SizeCard({
  size,
  current,
  pressed = current,
  disabled,
  onClick,
}: {
  size: string;
  current: boolean;
  /** Whether the button stands for the size in force; the current one by default. */
  pressed?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  // Square: the minimum width is the height, and the padding is small
  // enough that "XS" and "XL" fit inside it. "unsized" and a half size
  // such as "XS+" grow wider.
  const shape = current
    ? "bg-primary text-primary-foreground border-primary h-12 min-w-12 px-2 text-lg font-extrabold shadow-sm"
    : "bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 h-7 min-w-7 px-1 text-xs";
  const className = `inline-flex items-center justify-center rounded-md border font-mono font-medium transition-[height,min-width,padding,font-size,font-weight,color,background-color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${shape}`;
  if (onClick === undefined) {
    return <span className={className}>{size}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.98] motion-reduce:active:scale-100`}
      disabled={disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {size}
    </button>
  );
}

function DeliveryStatus({
  operation,
  busy,
  mutate,
}: {
  operation: BountyWritebackDto;
  busy: boolean;
  mutate: (
    path: string,
    body: object,
    options?: { apply?: boolean },
  ) => Promise<boolean>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>
        Jira: <strong>{operation.status}</strong>
        {operation.step === "label" && operation.status !== "done"
          ? " (comment posted; label pending)"
          : ""}
      </span>
      {operation.status === "failed" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void mutate(`/writebacks/${operation.id}/retry`, {})}
        >
          Retry
        </Button>
      )}
      {operation.status === "uncertain" && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void mutate(`/writebacks/${operation.id}/reconcile`, {})
          }
        >
          Check Jira
        </Button>
      )}
      {(operation.status === "pending" || operation.status === "failed") && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void mutate(`/writebacks/${operation.id}/cancel`, {})}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}
