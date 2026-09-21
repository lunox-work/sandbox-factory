/**
 * The provider marks shown on the sign-in buttons.
 *
 * Inline SVG rather than an icon package: there are three of them, and a
 * dependency for that would outweigh what it replaces. Each is decorative —
 * the button's label already names the provider — so they are hidden from
 * assistive technology rather than announced a second time.
 */

import type { ReactElement } from "react";

import type { ProviderId } from "./auth";

/**
 * Keyed by `ProviderId` rather than looked up loosely, so adding a provider to
 * `PROVIDERS` without giving it a mark here fails the type-check instead of
 * rendering a button with a hole in it.
 */
const ICONS: Record<ProviderId, ReactElement> = {
  // Google's mark is its four colours; a monochrome "G" is not the logo.
  google: (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  ),
  // `currentColor`, so the mark follows the text colour into dark mode. A
  // fixed black would disappear against the dark background.
  github: (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  ),
  // The lighter of Atlassian's two blues: it holds up on both backgrounds,
  // where the darker one sinks into the dark theme.
  atlassian: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#2684FF"
        d="M7.12 11.084a.683.683 0 0 0-1.16.126L.075 22.974a.703.703 0 0 0 .63 1.018h8.19a.678.678 0 0 0 .63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 0 0-.906 15.317l3.95 7.9a.703.703 0 0 0 .628.388h8.19a.703.703 0 0 0 .63-1.017L12.63.38a.664.664 0 0 0-1.196.006z"
      />
    </svg>
  ),
};

export function ProviderIcon({ provider }: { provider: ProviderId }) {
  return ICONS[provider];
}

/**
 * Jira's own mark, which is not Atlassian's.
 *
 * The distinction is the point of keeping both: signing in goes through
 * Atlassian the account provider, so the sign-in screen and the account page
 * show the Atlassian mark. The Connections card names the *product* whose
 * boards get read, which is Jira. Same company, two different things being
 * named, so `ICONS.atlassian` stays where it is.
 */
export function JiraIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/*
        Three nested chevrons, each offset from the last. The coordinates are
        Atlassian's own, shifted up by 2.7 so the third one ends at 24 rather
        than running past the viewBox and clipping.
      */}
      <path
        fill="#2684FF"
        d="M11.08 0a5.32 5.32 0 0 0 5.32 5.32h2.2v2.12a5.32 5.32 0 0 0 4.95 5.3V.78A.78.78 0 0 0 22.77 0z"
      />
      <path
        fill="#2684FF"
        d="M5.54 5.57a5.32 5.32 0 0 0 5.32 5.32h2.19v2.12a5.32 5.32 0 0 0 5.32 5.32V6.35a.78.78 0 0 0-.78-.78z"
        opacity=".75"
      />
      <path
        fill="#2684FF"
        d="M0 11.14a5.32 5.32 0 0 0 5.32 5.32h2.19v2.12a5.32 5.32 0 0 0 5.32 5.32V11.92a.78.78 0 0 0-.78-.78z"
        opacity=".5"
      />
    </svg>
  );
}

/**
 * Slack's mark, kept out of `ICONS` because Slack is not a sign-in provider.
 *
 * `ProviderId` is the union of what the sign-in screen offers, and widening it
 * to carry an icon would let `signInWith("slack")` type-check against a
 * provider the API has never heard of. The Connections card names tools, not
 * ways in, so it reaches for this directly.
 */
export function SlackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="#E01E5A"
        d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
      />
      <path
        fill="#36C5F0"
        d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
      />
      <path
        fill="#2EB67D"
        d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
      />
      <path
        fill="#ECB22E"
        d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"
      />
    </svg>
  );
}
