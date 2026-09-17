# Sign-in page revamp

Approved 2026-09-18. Layout: centered, atmospheric.

## Goal

Replace the placeholder signed-out screen ("Todos" / "Sign in to see your
todos.") with a branded Lunox sign-in page. The signed-in screens are out of
scope and must not change.

## Design

- **Visual thesis:** calm and precise. The gradient `>/<` mark is the only
  colour on a near-monochrome surface, with a soft glow of the same
  cyan → blue → periwinkle gradient behind it.
- **Content, top to bottom:** logo, `Lunox` (the loudest text), the tagline
  `See less, Build more`, the provider buttons, the error alert when present,
  and the existing build footer pinned to the bottom of the viewport.
- **No cards and no form.** Email and password is disabled on the API.
- **Provider icons:** inline SVG in `src/ProviderIcon.tsx`, in a map keyed by
  `ProviderId` so a provider added without an icon fails the type-check.
  Google is four-colour, GitHub is `currentColor`, Atlassian is blue.
- **Motion, CSS only:** a staggered fade-and-rise entrance; a lift on button
  hover; a spinner replacing the clicked provider's icon while redirecting.
  All of it is disabled under `prefers-reduced-motion`.
- **Theming:** existing colour tokens. The logo swaps to
  `logo-gradient-dark.svg` in dark mode through `<picture>`.
- **Scope of CSS:** everything new is under `.signin`, so the todos and
  account screens are untouched.

## Unchanged behaviour

`?error=` handling, the pending state, the `signInWith` flow and the button
labels. No new dependencies.

## Testing

`test/signin.test.tsx`: the brand and tagline render and the old "Todos" copy
is gone; every provider button carries an icon; clicking a provider starts
sign-in, labels that button "Redirecting…" and disables the rest; a failed
start shows the alert and re-enables the buttons.
