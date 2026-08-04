# POD-1658 — how to get a CPU profile that names real functions

The recipe, the decision behind it, and the evidence it works. Companion to
[pod-1641](pod-1641-client-freeze-profile.md) (which found the freeze) and
[pod-1645](pod-1645-ownership-index.md) (which benched the fix). Those two
harnesses are still the right tools; this adds the missing step — turning a
mangled profile of the **built** bundle back into source names.

## The problem this solves

A CDP `Profiler` run against the shipped bundle came back like this:

```
  6.55%  ure   index-RR9HhGf3.js
  5.9%   dre   index-RR9HhGf3.js
  ...    ese, rS, Ox
```

No dominant frame, 41% idle, nothing actionable — and POD-1651 stalled behind it.
The names are not missing information, they are *unresolved* information: the
minifier recorded the mapping and the build was throwing it away.

## The decision: (c) both, but they answer different questions

| | vite dev server (`bun run host`) | built dist (`bun run --filter @podium/web build`) |
|---|---|---|
| names in a profile | already real — esbuild does not mangle in dev | mangled, **now** resolvable via `dist/**/*.map` |
| what you are measuring | a per-module ESM graph, ~1500 separate requests, no tree-shaking, no chunking | the actual code users run |
| use it for | "where is this error thrown", quick iteration | **anything performance** |
| cost | none (already the default) | ~23 MB of `.map` in dist; +~20 s build; 0 bytes shipped |

The dev server was never the problem — it names functions fine. It is the wrong
thing to *profile*, because its module graph has performance characteristics the
shipped bundle does not have. So the change that matters is on the build side, and
**both** paths are now covered.

## What changed

1. **`apps/web/vite.config.ts` — `build.sourcemap: 'hidden'`, on every build.**
   Maps land in `dist/assets/*.map`; **no `//# sourceMappingURL=` comment is
   emitted**, so no browser fetches one and no end user is served a byte of our
   sources. That is deliberate, and it is sufficient: the CDP profiler reports raw
   `file:line:column` frames and never consults a source map anyway — resolution
   happens offline, against the map on disk.

   `PODIUM_SOURCEMAP=linked bun run --filter @podium/web build` emits the reference
   comment instead, for when you want Chrome/Firefox DevTools to resolve the bundle
   interactively (breakpoints, the DevTools performance panel). Local builds only —
   with that flag the maps *are* fetched by anyone who opens DevTools.

2. **`scripts/precompress-dist.ts` — `.map` removed from the compressible set.**
   POD-1655's brotli-11 pass was about to spend build time on 23 MB of files that,
   being hidden, nobody ever requests. The server still compresses a `.map` on the
   fly if someone fetches one directly, so nothing regresses.

   Verified untouched otherwise: `[precompress] 24 files: 5.10 MB raw -> 1.16 MB br
   / 1.43 MB gzip` — the same 24 assets as before this change, no `.map.br` written.

3. **Cache headers: unchanged, and correct as-is.** `isImmutableAsset` in
   `apps/server/src/static-web.ts` keys on a content hash *immediately before the
   final extension*, so `index-C4vwNIeS.js` gets `immutable` and
   `index-C4vwNIeS.js.map` gets `no-cache`. With hidden maps nothing requests them,
   and with `PODIUM_SOURCEMAP=linked` a revalidating map is what you want anyway —
   a stale cached map is exactly the failure mode that produces confident wrong
   names.

4. **`docs/agents/pod-1658/profile.mjs`** — capture (thin descendant of
   pod-1641's `cdp.mjs`, parameterised for any instance, with an optional route
   walk).
   **`docs/agents/pod-1658/resolve-profile.mjs`** — resolve + aggregate
   (replaces pod-1641's `cdpan.mjs` for built bundles).

### One caveat, stated rather than fixed

`dist/sw.js` and `dist/workbox-*.js` carry their own `sourceMappingURL` comments
and always have — workbox-build emits them, and `VitePWA` gives no knob for it.
Those maps cover the generated service worker and the workbox library, not app
sources. Left as-is; noted so nobody reads it as a leak from this change.

## The recipe

```bash
# 1. Build. Maps are on by default now — nothing to remember.
bun run --filter './packages/*' build && bun run --filter @podium/web build

# 2. Serve it. NEVER against ~/.podium or :18787 — isolate.
PODIUM_STATE_DIR=/tmp/prof-state PODIUM_PORT=18899 \
  bun --conditions=@podium/source scripts/server.ts

# 3. Capture. PODIUM_COOKIE=<podium_session> if the instance has a password;
#    PODIUM_WALK cycles client-side routes instead of profiling a plain load.
PODIUM_WALK=/issues,/usage,/workflows \
  node docs/agents/pod-1658/profile.mjs http://127.0.0.1:18899/ 45 run.cpuprofile

# 4. Resolve. The dist you profiled — the maps must match the bundle exactly.
node docs/agents/pod-1658/resolve-profile.mjs run.cpuprofile apps/web/dist/assets 25
```

Wall-clock timings come from Firefox (it loads the authenticated app reliably on
this box); Chromium + CDP is for the profile, because it samples from the browser
process and needs no cooperation from a wedged page.

### How the resolver gets a *name*, not just a location

Two lookups, not one. The location is a plain `originalPositionFor`. The **name**
usually is not in the mapping — a minifier records `name` for a position only when
it renamed an identifier *at that position*, and a function's entry position often
carries none. So when `pos.name` is empty the resolver reads the original file out
of the map's `sourcesContent` and lifts the declared identifier at the mapped
line:column. That is the declaration site, so the name is sitting right there.

It also folds by resolved identity: one source function is many bundle nodes
(inlining, multiple call sites). Reporting them separately is a large part of why
the original profile looked like a flat "6% everywhere" and named nothing.

## Evidence

Built dist at `dist/assets/index-C4vwNIeS.js` (this branch), served by an isolated
server on :18899, 45 s CDP capture, 1 ms sampling.

**Before** (pod-1641's `cdpan.mjs`, no map — the state the issue described):

```
--- TOP SELF TIME ---
    0.20s   0.3% u      /assets/index-C4vwNIeS.js:33:139298
    0.17s   0.3% (anon) /assets/index-C4vwNIeS.js:33:10623
    0.15s   0.3% u      /assets/index-C4vwNIeS.js:33:139298
    0.15s   0.2% iD     /assets/index-C4vwNIeS.js:33:15089
    0.14s   0.2% IE     /assets/index-C4vwNIeS.js:33:9243
```

**After** (`resolve-profile.mjs`, the same profile, the same run):

```
scripted time 5.17s — percentages below are OF THAT; resolved 97.8%

--- TOP SELF TIME (source-mapped) ---
    0.357s   6.9%  project                    packages/client-core/src/replica/kernel/facade.ts:239
    0.339s   6.6%  (garbage collector)
    0.197s   3.8%  (anon)                     packages/client-core/src/replica/use-issue-views.ts:246
    0.141s   2.7%  projectionToViewInput      packages/client-core/src/replica/issue-views.ts:387
    0.123s   2.4%  keyOf                      packages/client-core/src/replica/kernel/facade.ts:266
    0.078s   1.5%  buildIssueTree             packages/client-core/src/replica/issue-views.ts:290
    0.058s   1.1%  recomputeIssueProjections  packages/client-core/src/engine/optimism.ts:249
```

Real functions, real files, real lines — including `recomputeIssueProjections`, the
POD-1641 family. That is the deliverable.

See [pod-1658/](pod-1658/) for the two scripts and
[pod-1658-evidence.md](pod-1658-evidence.md) for the full captured output.
