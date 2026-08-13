# POD-1980 — the phone website's build stamp, verified

**Date:** 2026-08-13 · parent: [POD-1610's gate](../pod-1610-stale-bundle-gate.md) ·
acceptance: *"the phone export carries the same checkout stamp the desktop dist does, and
Update can compare it and rebuild from it"*.

Unit tests prove each piece. Two things they cannot prove are recorded here: that the
stamp survives a **real** `expo export -p web`, and that the composition root actually
hands `/version` the dist it serves. Both are seams, and a seam is where wiring silently
goes missing.

## The stamp, from a real export

`bun run --filter @podium/mobile build:web` in this worktree — Metro export, then the
install-metadata patch, then the stamp:

```
Exported: dist
patched viewport, install metadata and shell styles in dist/index.html
[podium] build stamp: wire schema ba27fe60c4bc59e6, version dev+2eed672,
         bundle bundle+a67fe97225b33fc8b119d26e2ea9b0d4, source 2eed672 → apps/mobile/dist
```

`apps/mobile/dist/podium-build.json`:

```json
{
  "wireSchemaDigest": "ba27fe60c4bc59e6",
  "wireVersion": 2,
  "builtAt": "2026-08-13T11:25:22.103Z",
  "appVersion": "dev+2eed672",
  "sourceSha": "2eed672",
  "bundleVersion": "bundle+a67fe97225b33fc8b119d26e2ea9b0d4"
}
```

All three survive together: the stamp file, the `<meta name="podium-version">` the page can
read synchronously, and the `<style id="podium-shell">` marker that proves the install
patch was not clobbered. `bundleVersion` names the file Metro actually emitted
(`entry-a67fe97225b33fc8b119d26e2ea9b0d4.js`) — the same string a crash stack from the
phone prints.

The desktop dist's stamp is unchanged; the same script writes both, and only the
entry-chunk hash differs (Vite's base64url-8, Metro's hex-32, both read in
`bundleVersionFromHtml`).

## What the server says about the phone it serves

An **isolated** server from this worktree (`PODIUM_STATE_DIR` under /tmp,
`PODIUM_INSTANCE=pod1980`, `PODIUM_PORT=18795`, no daemon) with
`PODIUM_MOBILE_WEB_DIR` pointed at a phone dist whose stamp was edited between reads. The
live dev host on `:18787` was untouched and confirmed healthy after; the isolated state
dir was removed.

Its published target was `dev+048da84`, so `artifacts.web.digest` is `048da84` throughout.

| The phone dist on disk | `/version` → `mobileWeb` | Verdict |
| --- | --- | --- |
| stamped `048da84` | `{present: true, digest: "048da84"}` | current |
| stamped `0d1c0de` (an older export) | `{present: true, digest: "0d1c0de"}` | **behind** |
| `index.html`, no `podium-build.json` | `{present: true}` | **behind** — cannot be certified |
| no `index.html` at all | field omitted entirely | nothing to do |
| `index.html` put back | `{present: true}` | **behind**, without a restart |

The last row is the one worth having: presence is probed per request, not captured at
boot. The phone export is gitignored and built by a separate unit that can finish long
after the server started, so a boot-time flag would have answered "no phone website" for
the rest of the process's life.

The second-to-last row is the reason the SERVER answers this and not the page. A page
fetching `/mobile/podium-build.json` gets the same 404 whether the export is
stale-without-a-stamp or was never built, and those two need opposite verdicts —
"rebuild it" versus "there is nothing here".

### An accident worth keeping

The first fixture used `0ldc0de` as the stale checkout, which is not hex. `webSourceDigest`
refused it and the server reported `{present: true}` with no digest — a dist that cannot
name its checkout, graded as behind. The guard against a garbage stamp fired without being
asked to.

## Both new guards proven armed

Each was watched to fail with the phone clause disabled, then restored:

- `startUpdate` — `router.updates.test.ts` "CAN SAY NO: rebuilds when only the phone export
  is on an older commit" and "rebuilds a phone export that cannot name its commit at all"
  both fail when `webBehind`'s phone term is stubbed out.
- the dialog — `use-update-state.test.tsx` "offers Update when only the phone export is
  behind" fails when `phoneStale` is stubbed out.

## Not covered

- **The dialog was not driven in a browser.** Its phone row is asserted through the real
  component (`UpdateDialog.test.tsx`) and the real hook (`use-update-state.test.tsx`), but
  no screenshot of an actual stale-phone installation was taken.
- **The rebuild itself was not run from the button.** `requestWebRebuild` is the server's
  own web-build step (POD-1985), whose step list already runs `@podium/web build` and
  `@podium/mobile build:web`; that path is unchanged by this issue and driving it on the
  live host is not something to do casually.
- ~~**The dest-tarball gate's own staleness check still reads only the desktop dist.**
  `dev-web-build.ts`'s `ensure()` decides "is the dist at HEAD" from
  `apps/web/dist/podium-build.json` alone. The gate that matters for a bundle leaving this
  machine — `continueDevelopmentUpdate`'s wait — now covers both dists (see below), but
  widening `ensure()` is a decision for whoever owns that build step.~~
  **This was the defect POD-1989 then fixed** — `ensure()` returning early on the desktop
  half meant the button this issue lit up started no export at all. See
  [POD-1989](POD-1989-stale-phone-rebuild.md).

## Landing on a moved main

Between review and landing, main gained POD-1985/POD-1986: the web build became a step the
server itself awaits rather than a systemd unit it restarts, `servedWebDigest` became a
lazily-read thunk, and that thunk is now polled by `continueDevelopmentUpdate` before a
development tarball is packed for other machines — "do not ship yesterday's website under
today's sha".

"Is the website behind" is one question, so it gets one answer: `websiteDigestReader`
composes the two dists into a single reader that names a commit only when both halves do.
That is what `webBehind` measures.

The tarball gate deliberately does NOT use it — a correction the POD-1982 session's landing
note prompted. That wait exists to protect the bytes it packs, and the dest tarball carries
`apps/web/dist` only. Waiting on the phone export there would hold every remote machine's
update for bytes none of them receive. So it keeps reading the desktop dist, a phone-only
staleness satisfies it immediately, and the phone half is finished by the page's own wait
instead. Two consumers, two questions, which is why the reader is a named function rather
than a widened variable.

(That the dest tarball omits the phone export at all is pre-existing and not this issue's.)
- **The phone shell still gets no stale-build banner.** `stampCheck` stays opt-in for the
  desktop dist. Deliberate: the desktop's staleness law must take no input from the phone.
