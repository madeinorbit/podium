# POD-1989 — the rebuild button rebuilds the phone, verified

**Date:** 2026-08-13 · follows [POD-1980](POD-1980-phone-website-stamp.md) ·
acceptance: *"a phone export left on an older commit is rebuilt when Update is pressed,
even when `apps/web/dist` is already at HEAD"*.

## The defect

POD-1980 taught the read model that a present phone dist with the wrong digest is
`webBehind`, so Update lit up. It named its own remaining gap in "Not covered": the build
step that button drives was never widened to match.

`requestWebRebuild` → `webBuilder.requestRebuild()` → `ensure(headSha)`, and `ensure()`
decided "the website is built" from `apps/web/dist/podium-build.json` alone. With the
desktop half at HEAD it returned `Promise.resolve()` on the spot, `state()` went straight
to `ready`, and neither of `DEV_WEB_BUILD_STEPS` ran. So the button:

1. reported success immediately,
2. exported nothing,
3. left `/version`'s `mobileWeb.digest` on the old commit,

and the page's `waitForWebIdentity` — which polls that exact field — spent its full 300
attempts before failing with "Podium rebuilt the server, but the matching app did not
become ready." The same held after a dest-redeploy whose desktop dist was already current.

## The fix

`ensure()` now asks about the WEBSITE, both halves of it:

```ts
const websiteAtHead = (headSha: string): boolean =>
  webDistMatchesHead(readStamp(deps.root), headSha) &&
  !phoneDistBehindHead(readPhone(deps.root), headSha)
```

`phoneDistBehindHead` is the predicate the other two consumers already agree on — the
server's `websiteDigestReader` and the page's `phoneBehind` — so the button now fires on
exactly the condition that offered it, and on no other:

| phone dist | verdict | `ensure()` with a current desktop dist |
| --- | --- | --- |
| stamped at HEAD | current | returns, no process |
| stamped at another commit | **behind** | runs both build steps |
| on disk, no stamp | **behind** — cannot be certified | runs both build steps |
| absent entirely | nothing to rebuild | returns, no process |

The last row is what keeps this safe on the `/version` path: an installation that never
exported a phone website must not be dragged into a build every 60 s.

`build()`'s post-check was widened the same way, and names the two dists separately —
HEAD moving mid-build fails here rather than deep inside the compile, and the operator's
next move differs (the vite log versus the expo log).

## Both guards proven armed

Each new test was watched to FAIL before being trusted (POD-1610's rule that a check which
cannot say no is not a check):

- With `phoneDistBehindHead` stubbed to `false` — the pre-fix behaviour exactly — three
  tests fail: `recognises a phone export left on another commit`, `rebuilds for a stale
  phone export while the desktop dist is at HEAD`, and `fails when the finished build left
  the phone export behind`. Restored, all pass.
- With the default reader pointed one directory off (`apps/mobile/web-dist`), `reads the
  phone export where the export step actually writes it` fails. Restored, it passes.

That second one is the composition-root guard. Every other test in the file stubs
`readPhone`, so a reader pointed at the wrong path would report `{present: false}` — which
reads as NOT behind — and the defect would return with a green suite. It builds a real
temp tree and asserts against the stamp shape POD-1980 recorded from a real
`expo export -p web`.

`apps/server/src/modules/updates/dev-web-build.test.ts`: 12 passed. The updates module plus
`router.updates.test.ts`: 163 passed. `bun run typecheck`: 24/24.

## Not covered

- **The button was not pressed on a live host.** The defect and the fix are both in a pure
  decision — "is the website at HEAD" — driven here through the real readers against a real
  directory, but no stale-phone installation was rebuilt end to end from the panel. Driving
  it on the live dev host is not something to do casually.
- **The phone export itself was not re-run.** That the export writes the stamp this reader
  finds is POD-1980's evidence, reused here as the fixture shape rather than re-measured.
- **`lint:boundaries` is red on this branch**, on four files this change does not touch
  (`store.ts`, `client-core/engine/runtime.ts`, `PulseScreen.tsx`, `DiffSheet.tsx`). The
  same violations are present on `origin/main`; pre-existing, not this issue's.
