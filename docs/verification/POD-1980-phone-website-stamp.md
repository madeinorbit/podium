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
- **The rebuild itself was not run from the button.** `requestWebRebuild` restarts
  `podium-web.service`, whose `ExecStart` already builds both dists; that path is unchanged
  by this issue and restarting it on the live host is not something to do casually.
- **The phone shell still gets no stale-build banner.** `stampCheck` stays opt-in for the
  desktop dist. Deliberate: the desktop's staleness law must take no input from the phone.
