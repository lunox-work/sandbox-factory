# Identicon avatars

Deterministic default profile pictures for users and organizations, computed
from the account id at render time. No media is stored, uploaded, or served.

## Why

Users have `user.image`, a URL the OAuth provider hands us at signup. It is
null for anyone whose provider gave no picture, and it goes stale: provider
CDNs 404 their own avatar URLs over time. Today that case falls back to
initials.

Organizations have no avatar at all. Org rows render a lucide `Building2`
glyph, identical for every organization, and member rows in
`Organization.tsx` render no picture even though the API already sends
`image` for each member.

An identicon derived from the account id fixes both without introducing an
upload path, a bucket, a resize pipeline, or a CDN behavior.

## Scope

In scope: a pure id → identicon function, a React component that renders it,
one shared avatar component, and wiring at the three places an avatar belongs.

Out of scope: uploading avatars, object storage (`packages/db/src/objects.ts`
stays unconsumed), any HTTP image endpoint, any CloudFront or nginx change,
and **exposing `organization.logo`** — see _Why `logo` stays unexposed_.

## Design

### The seed

The account id — `user.id` or `organization.id`. Permanent, opaque, unique,
and already present in every DTO that needs it: `organizationSummarySchema.id`
(`packages/shared/src/index.ts:56`), `organizationMemberSchema.userId`
(`:79`), and `session.user.id`, which `apps/web/src/App.tsx:38` already reads
to key the remount.

Ids are not uniformly formatted. Better Auth mints bare ids for users and for
plugin-created organizations; `generateId()` in `packages/db/src/mapping.ts:43`
mints `org_<uuid>` for personal organizations. The hash consumes the id as
opaque UTF-8 bytes, so the two families need no special handling — but no
visual property is ever derived from a prefix, because one family has none.

The seed is never the name, the handle, or the email. An identicon must not
change when someone renames themselves or their organization.

### `identicon(seed)` — `packages/shared/src/identicon.ts`

```ts
export interface Identicon {
  /** 25 cells, row-major, 5x5, mirrored across the vertical axis. */
  readonly cells: readonly boolean[];
  /** 0-359. */
  readonly hue: number;
}

export function identicon(seed: string): Identicon;
```

Pure, synchronous, no imports. Identical output in Node and in the browser.
`apps/web` already imports runtime values from `@sandbox-factory/shared`
(`BuildReadout.tsx:17`), so this adds no new dependency edge to the bundle.

**The algorithm is pinned exactly, because it is a contract.** Any change to
it silently changes every existing account's face.

1. `h` = FNV-1a, 32-bit (offset basis `0x811c9dc5`, prime `0x01000193`), over
   the UTF-8 bytes of the seed, as an unsigned integer.
2. Fifteen independent cells, three columns by five rows: the cell at row `r`,
   column `c` (`c` in 0..2) is filled when bit `r * 3 + c` of `h` is set.
3. Columns 0 and 1 are mirrored into columns 4 and 3.
4. If none of the fifteen bits is set, the centre cell (row 2, column 2) is
   forced on.
5. `hue = (h >>> 15) % 360` — the seventeen bits not spent on cells.

**Why FNV-1a and not a cryptographic hash.** The seed is an id already visible
to anyone who can see the avatar, so there is nothing to protect, and
`crypto.subtle.digest` is async in the browser, which would make an avatar a
promise. The source file says so, so that nobody later "upgrades" it.

**Why no avalanche finalizer.** FNV-1a's low bits are its weakest, and cells
are drawn from the low bits, so this was measured rather than assumed: across
8,000 pairs of `org_<uuid>` ids differing only in their last character, 7.26
of 15 cell bits flip on average (ideal 7.5) and no pair produced the same
grid; `user_0`..`user_999` give 1,000 distinct grids. Adding murmur3's
`fmix32` moved the first figure to 7.49 and nothing else. Not worth five more
lines in a function whose output can never change.

**Mirroring** is what makes the result read as a deliberate mark rather than
as noise. It is the single most important visual decision here.

**The empty-grid guard** is reachable — one hash in 2^15 — so it is tested
directly rather than left to chance.

### Color

The function returns a hue and nothing else. Lightness and chroma are **CSS
tokens**, not derived values and not constants in TypeScript:

```css
/* apps/web/src/index.css */
:root {
  --identicon-l: 0.55;
  --identicon-c: 0.09;
}
.dark {
  --identicon-l: 0.75;
  --identicon-c: 0.12;
}
```

and the component fills with
`oklch(var(--identicon-l) var(--identicon-c) <hue>)`.

`oklch`, matching every other token in `index.css`, whose header comment
already gives the reason: lightness is perceptual. The earlier draft of this
spec said `hsl(hue 65% 45%)` "guarantees every identicon has the same
contrast". It does not. HSL lightness is not perceptual: measured against the
`muted` token, that formula ranges from 9.09:1 (blue, hue 240) down to
**1.85:1** (yellow, hue 60) in the light theme, and down to **1.26:1** in the
dark theme — a blue identicon would be close to invisible on a dark card.

With the tokens above, contrast against `muted` is 4.21–4.63:1 across all 360
hues in light and 6.33–7.06:1 in dark. Both chroma values are the largest that
stay inside sRGB at every hue for their lightness, so no browser gamut-maps
any identicon and the measured range is the rendered range.

Being tokens, they can be tuned by eye in one CSS rule without touching the
pinned algorithm or anyone's grid.

### `<Identicon>` — `apps/web/src/components/Identicon.tsx`

```tsx
<Identicon seed={id} />
```

Inline SVG, `size-full`, scale-free: the same element is correct at 24px in
the rail and at 96px on a settings page.

**`viewBox="-1 -1 7 7"` — one cell of padding on every side.** User avatars
are clipped to a circle. With an unpadded `0 0 5 5` viewBox, only 14% of each
corner cell survives the crop, so any identicon with a corner filled renders a
sliver; half a cell of padding leaves 69%; a full cell leaves 100%. GitHub pads
its identicons for the same reason. Organizations, in a rounded square, do not
strictly need it, but one viewBox keeps one code path and makes a person and
an organization with the same grid recognisably the same mark.

**One `<path>`, not one `<rect>` per cell.** At 24px a cell is 3.43 device
pixels wide. Abutting rects at fractional sizes anti-alias independently and
show hairline seams between cells that should read as one block; a single
path is rasterised with one coverage pass and has none. It is also one DOM
node instead of up to twenty-five, which matters in a member list. Each filled
cell contributes `M{x} {y}h1v1h-1z` to `d`.

No background geometry. `AvatarFallback` already paints `bg-muted`, which
follows the theme.

`aria-hidden="true"` and `focusable="false"`, matching
`apps/web/src/ProviderIcon.tsx:19` — the existing precedent for hand-written
inline SVG. The name beside or behind the avatar carries the meaning; the
identicon carries none a screen reader needs.

Feature components live in `apps/web/src/`, not in `components/ui/`, which is
reserved for verbatim shadcn output.

### `<EntityAvatar>` — `apps/web/src/components/Avatar.tsx`

`UserAvatar` is currently private to `UserMenu.tsx:124-153`. It is extracted
so the call sites share one component, and renamed because it now serves
organizations too.

```tsx
<EntityAvatar id={id} image={image} shape="circle" className="size-6" />
```

- **`id`** is required. A missing id would mean a silently different face for
  the same entity on two screens, which is worse than a type error.
- **`shape`** is `"circle" | "square"`, required. A prop rather than a
  `rounded-md` class at each organization call site, so the user/organization
  distinction is one decision in one place and cannot be forgotten at a new
  call site. There is a trap a className convention walks into: shadcn's
  `AvatarFallback` carries its own `rounded-full` (`ui/avatar.tsx:52`), so
  squaring only the root leaves a muted _circle_ inside a rounded square. The
  component passes `rounded-[inherit]` to the fallback.
- **`name` is dropped.** It existed only to feed `initials()`.

The existing structure is kept: Radix `AvatarFallback` renders until
`AvatarImage` loads and keeps rendering if the image errors, so a stale
provider URL falls through to the identicon with no extra code
(`UserMenu.tsx:136-142` documents why). `AvatarImage` is still omitted when
`image` is null or empty, and `referrerPolicy="no-referrer"` is kept.

Two changes:

1. The fallback body becomes `<Identicon seed={id} />`. `initials()` and its
   lucide `User` glyph are deleted; the identicon needs no name and has no
   degenerate case.
2. When `image` is set, the fallback gets `delayMs={400}`. Radix shows the
   fallback _while the image loads_, not only when it fails. Initials flashing
   before a photo is quiet; a saturated pixel grid flashing before a photo on
   every page load is not. With the delay, an account with a working picture
   never shows its identicon, and one with a dead URL shows it 400ms late.
   With no `image`, there is no delay.

### Call sites

| Site                        | Today                                            | After                                                                            |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `UserMenu.tsx:53`, `:144`   | `UserAvatar`, initials fallback                  | `EntityAvatar`, `shape="circle"`, seeded by `session.user.id`                    |
| `Organization.tsx:182-206`  | member rows: name, `@username`, role — no avatar | `EntityAvatar`, `shape="circle"`, per member; `image` is already in the response |
| `Organizations.tsx:130-134` | lucide `User` / `Building2` mark                 | see below                                                                        |

**Member rows are seeded by `entry.userId`, not `entry.id`.** The row key is
the `member` row id. Seeding from it would give one person a different face in
every organization they belong to.

**The personal organization row shows the person, not the organization.** A
personal organization has its own id, so seeding from it would give someone
one face in the rail and a different one, in a different shape, on the row
that `Organizations.tsx:9-12` says is "theirs rather than shared" —
`packages/shared/src/index.ts:47` says surfaces present it as someone's own
account. So: a `kind === "personal"` row renders the viewer's own avatar
(`session.user.id`, `session.user.image`, circle); a team row renders
`organization.id`, no image, square. `Organizations` gains a
`viewer: { id: string; image: string | null }` prop. The personal row is always
the viewer's own — nobody is ever listed in someone else's personal
organization — so no owner id needs to cross the API.

`userId` is threaded `App.tsx:41` → `Signed` → `SideNav` → `UserMenu`,
following the existing `image` chain.

### Why `logo` stays unexposed

An earlier draft added `logo` to `organizationSummarySchema` so a real logo
could outrank the identicon, on the stated ground that there is "no write
path". That is false. Better Auth's organization plugin accepts
`logo: z.string()` — any string — in the body of both
`/api/auth/organization/create` and `/update`
(`better-auth/dist/plugins/organization/routes/crud-org.mjs:16,163`), and the
hooks in `apps/api/src/auth.ts:550-575` spread the incoming body through
untouched. Anyone signed in can already store an arbitrary URL there.

Today that is inert, because nothing reads the column. Rendering it would turn
it into an `<img src>` chosen by one account and fetched by another's browser.
`pendingInvitationSchema` embeds `organizationSummarySchema`, so the fetch
would not even be limited to members: create an organization (self-serve, no
approval), set `logo` to a URL you control, invite any handle, and the
recipient's browser calls your server when they open their invitations —
address, user agent, and the moment they looked. There is no CSP in
`nginx.conf` or `infra/` to stop it.

Making that safe means validating the URL on write, deciding which hosts are
acceptable, and probably proxying — which is the upload feature. It belongs
with `docs/architecture.md:244`, which stays as written. With no product
surface that sets a logo, the identicon is not a fallback for organizations;
it is the avatar.

## Testing

`packages/shared` enforces 90% line, branch, and function coverage plus
`assert-all-covered`. Tests for `identicon()`:

- **Golden vectors** — four literal seeds (a bare Better Auth-style id, an
  `org_<uuid>`, the empty string, a non-ASCII string) each pinned to their
  exact `cells` and `hue`. This is the test that matters most: "same input,
  same output within one run" passes for any deterministic function, including
  a refactored one that has just changed every account's face. Only literals
  catch that. The comment on them says they are never to be regenerated.
- **Mirror symmetry** — for every row, cell 0 equals cell 4 and cell 1 equals
  cell 3, over 1,000 seeds.
- **Hue range** — integer, `0 <= hue <= 359`, same seeds.
- **Empty-grid guard** — a literal seed, found once at authoring time, whose
  hash has its low fifteen bits clear. The test first asserts that fact about
  the seed, so it fails loudly rather than passing vacuously if the hash is
  ever touched, then asserts exactly one filled cell, at index 12.
- **Distinctness** — `user_0`..`user_999`, deterministic, compared as
  `(cells, hue)` pairs: at least 998 distinct. The space is 2^15 × 360 ≈ 11.8M,
  so the expected number of colliding pairs is 0.04; 998 leaves room without
  permitting a broken hash.

`apps/web`, plain vitest matchers (there is no `jest-dom`):

- `Identicon`: a golden seed renders exactly one `path` whose `d` equals a
  literal; the `viewBox` is `-1 -1 7 7`.
- `EntityAvatar`: no `img` and an identicon when `image` is null;
  `rounded-[inherit]` reaches the fallback for `shape="square"`.
- `nav.test.tsx:350` ("an account with no picture falls back to its
  initials") asserts the behavior this spec removes and is rewritten for the
  identicon. `nav.test.tsx:331` (the provider picture wins) stays unchanged as
  the regression guard for precedence.
- `organization.test.tsx`: member rows carry an avatar, and two rows for the
  same `userId` with different member ids render the same `d`.
- An `Organizations` test: the personal row's `d` equals the rail avatar's.

## Alternatives considered

**An HTTP endpoint at the edge** — `GET /api/avatars/:id` returning SVG with a
long `Cache-Control`, fronted by a new CloudFront behavior. This was the
original framing. Rejected: the app renders its own avatars, so there is no
request to serve. It would add a Hono sub-router mounted outside the session
guard at `routes.ts:186`, a cache behavior in `infra/cloudfront.tf`, a
`location` block in `apps/web/nginx.conf`, and a 404 story — the SPA fallback
at `cloudfront.tf:132-148` rewrites 403/404 to `index.html` with a 200, which
would turn a bad id into an HTML page served as an image. All of that to
replace roughly forty lines of JavaScript that run during render.

The one thing a component cannot do is produce a URL usable outside the app,
such as an `<img src>` in a transactional email. There is no email transport
yet (`docs/architecture.md:242`). `identicon()` being a pure function in
`packages/shared` is what keeps that endpoint cheap to add later: a route that
calls it, builds the same path string, and sets headers. One caveat for that
day: an emailed SVG cannot read `--identicon-l`, so the endpoint would inline
the light-theme values.

**Storing generated images in S3** — rejected: it reintroduces the stored
media this feature exists to avoid, and adds invalidation for a value that is
a pure function of an immutable id.

**Deriving lightness or chroma from the hash** — rejected: it trades a
guaranteed contrast range for variety nobody asked for.

**A richer generator (jdenticon-style shapes, or a dependency)** — rejected:
the 5x5 grid is the chosen look, and a dependency's output is only stable
until its next major version.

**Keeping initials for users** — arguably more legible for a person whose name
you know. Rejected in favour of one treatment across both kinds; users and
organizations appear in the same lists, and two fallback styles there reads as
a bug.
