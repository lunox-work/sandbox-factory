/**
 * Which organizations the signed-in person belongs to, and which one the app
 * is currently showing.
 *
 * Reads come from `/api/v1/me/orgs` rather than the plugin's own list, which
 * does not carry the caller's role. Writes go through `authClient.organization`.
 *
 * The active organization is held here *and* pushed to the server with
 * `setActive`, for two different jobs: this copy decides what the current tab
 * renders, and the server's copy is what a reload restores. They are allowed
 * to differ between tabs, which is why nothing reads the server's copy to
 * decide what may be shown — see `requireMembership` in the API.
 */

import type { MembershipDto } from "@sandbox-factory/shared";
import { useCallback, useEffect, useState } from "react";

import { authClient } from "./auth";

interface State {
  organizations: MembershipDto[];
  loading: boolean;
  error: string | null;
}

export interface Organizations extends State {
  /**
   * The organization being shown. Null when the person belongs to none, and
   * also when they have deliberately stepped out of one — see {@link clear}.
   */
  active: MembershipDto | null;
  /** An explicit URL slug that is not present in the caller's memberships. */
  notFound: boolean;
  /**
   * The list has arrived but the effect that picks one from it has not run.
   *
   * One render long, and easy to mistake for "in none": a screen that shows
   * something different when there is no organization would flash it here.
   */
  settling: boolean;
  /** Switches organization, and remembers the choice for the next reload. */
  select: (organizationId: string) => void;
  /**
   * Steps out of the current organization, back to personal context, and
   * remembers that for the next reload.
   *
   * Distinct from "none chosen yet": belonging to organizations and viewing
   * none of them is a state someone can ask for, so the auto-select below
   * must not undo it.
   */
  clear: () => void;
  /** Re-reads the list, after a create, a rename or a leave. */
  refresh: () => Promise<void>;
}

export function useOrganizations(
  /**
   * The handle in the URL, when there is one. It wins over the remembered
   * choice, so a link to an organization opens that one.
   */
  preferredSlug?: string | undefined,
): Organizations {
  const [state, setState] = useState<State>({
    organizations: [],
    loading: true,
    error: null,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * Whether the person has deliberately stepped out of every organization.
   *
   * A separate flag rather than a third value on `activeId`, because null
   * already means "nothing settled yet" and the auto-select effect below has
   * to tell the two apart: it fills the first case and must leave the second
   * alone, or a deselect would bounce straight back to an organization.
   */
  const [deselected, setDeselected] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/me/orgs", { credentials: "include" });
      if (!res.ok) {
        setState({
          organizations: [],
          loading: false,
          error: "Could not load your workspaces.",
        });
        return;
      }
      const body = (await res.json()) as {
        organizations?: MembershipDto[];
      } | null;
      setState({
        // Defaulted, not trusted: a 200 carrying the wrong shape should leave
        // the switcher empty rather than throw through the whole app shell.
        organizations: body?.organizations ?? [],
        loading: false,
        error: null,
      });
    } catch {
      setState({
        organizations: [],
        loading: false,
        error: "Could not load your workspaces.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Settle on one organization once the list arrives: the one the URL names,
  // else the first. Runs again when the list changes, so leaving the active
  // organization moves to another rather than leaving a blank screen.
  useEffect(() => {
    if (state.organizations.length === 0) {
      setActiveId(null);
      return;
    }
    const named =
      preferredSlug === undefined
        ? undefined
        : state.organizations.find((entry) => entry.slug === preferredSlug);
    // A URL naming an organization is an explicit request for it, so it wins
    // over having stepped out: following a link should open what it points at.
    if (named !== undefined) {
      if (named.id !== activeId) {
        setActiveId(named.id);
      }
      if (deselected) {
        setDeselected(false);
      }
      return;
    }
    if (preferredSlug !== undefined) {
      if (activeId !== null) {
        setActiveId(null);
      }
      return;
    }
    // Having stepped out is a choice, not an empty slot to fill. Returning
    // here also keeps `activeId` honest: without it the effect would quietly
    // re-point it at an organization the person just left, which `active`
    // hides but anything reading the id directly would not.
    if (deselected) {
      return;
    }
    const stillThere = state.organizations.some(
      (entry) => entry.id === activeId,
    );
    const next = stillThere ? undefined : state.organizations[0];
    if (next !== undefined && next.id !== activeId) {
      setActiveId(next.id);
    }
  }, [state.organizations, preferredSlug, activeId, deselected]);

  const select = useCallback((organizationId: string) => {
    setDeselected(false);
    setActiveId(organizationId);
    // Best effort: the screen has already switched, and a failed write only
    // means the next reload starts somewhere else.
    void authClient.organization
      .setActive({ organizationId })
      .catch(() => undefined);
  }, []);

  const clear = useCallback(() => {
    setDeselected(true);
    setActiveId(null);
    // `null` is the plugin's documented way to unset it, so a reload comes
    // back to personal context rather than to whichever organization was
    // active before.
    void authClient.organization
      .setActive({ organizationId: null })
      .catch(() => undefined);
  }, []);

  // Derived from `activeId` alone. `clear` nulls it and the effect leaves it
  // null while `deselected`, so there is one rule about what is shown rather
  // than two that could disagree.
  const active =
    state.organizations.find((entry) => entry.id === activeId) ?? null;
  const notFound =
    !state.loading &&
    preferredSlug !== undefined &&
    !state.organizations.some((entry) => entry.slug === preferredSlug);

  const settling =
    !state.loading &&
    !deselected &&
    active === null &&
    (preferredSlug === undefined
      ? state.organizations.length > 0
      : state.organizations.some((entry) => entry.slug === preferredSlug));

  return { ...state, active, notFound, settling, select, clear, refresh };
}
