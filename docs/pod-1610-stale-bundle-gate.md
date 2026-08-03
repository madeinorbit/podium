# POD-1610 — catching a web bundle older than its server

What was chosen, why each part can actually fire, and what is still not covered.

## The failure, precisely

Two independent mechanisms turned "the dist is three days old" into "the app renders nothing".

**1. The catch-all disagreed with the union.** `UnknownFeedChange` — the arm that lets a
newer server stream entity kinds an older build does not know — excluded
`MetadataEntityKind.options`, a list maintained in a *different file* from the
`FeedChange` arms that do the parsing. A row whose kind is on that list but has no arm
fails the strict union (no arm) **and** the catch-all (the kind is "known"), so the whole
frame throws.

This was not only a stale-bundle story. On the integration tip before this change,
`MetadataEntityKind` listed ten kinds and `FeedChange` had eight arms: `userLayout` and
`userReadPosition` had no arm. A feed frame carrying either would have blanked every
current client. `feed.skew.test.ts` asserts that the two lists differ, so the test is not
vacuous, and then shows the old rule refusing a frame the new one accepts.

**2. A known kind whose payload moved.** The stale bundle required `IssueWire.blockedBy`
where the server had moved to `blockedByNotes`. No catch-all can rescue that — the kind
*is* known — so the only survivable behaviour is to drop the ROW and keep the frame.
`parseServerMessageLenient` quarantined per element for every collection message on the
wire except the frame family that carries everything.

## What shipped

| Piece | Fires when | Can it say NO? |
| --- | --- | --- |
| `FEED_ENTITY_KINDS` derived from `FeedChange.options` | never — it removes a failure mode by construction | n/a |
| Per-element quarantine for `feedDelta` / `feedBootstrap` | a row this build cannot read | a fully readable frame quarantines nothing (`feed.skew.test.ts`) |
| `hub.wireSkew()` tally + `WireSkewBanner` | a row is quarantined or a frame refused | an unknown *kind* is not a drop — forward compatibility is not skew |
| `wireSchemaDigest()` at `/version` + the client boot check | bundle and server were built from different protocol source | a matched pair is silent; a server that advertises no digest is silent |
| Build stamp + server-side grading + injected banner | the served dist is stamped differently, or not stamped at all | a matched stamp injects nothing, byte-for-byte |
| Root `build` includes `@podium/web` | — | — |

## Why the gate can fire — and why it is the SERVER that asks

The obvious gate is client-side: fetch `/version`, compare, complain. It exists (the boot
digest check) and it is useful, but it **cannot fire for the bundle that most needs it**,
because a bundle old enough to be broken is old enough to predate the check. The dist in
the incident was built three days before any code that would have noticed.

So the gate proper is the server's: it reads `podium-build.json` off disk beside
`index.html` and compares the digest with its own, computed from its own copy of the
schemas. Its verdict does not depend on a single line of what is inside the bundle, so a
stale dist from any era is caught the first time it is served — and the warning is
injected into the HTML, which is the only surface that reaches a user of a bundle that
cannot warn about itself.

**A missing stamp is `unstamped`, not `ok`.** Every build from this change on writes one,
so its absence means the dist predates the stamp — exactly the condition that cost three
days.

**Why a digest and not the wire version.** `WIRE_VERSION` answers "can this peer be
served" and is coarse by design (`version.ts`: bump only on a breaking framing change;
additive kinds negotiate by capability). The bundle and the server agreed on wire 2 for
the whole three days they failed to understand each other. The digest answers a different
question — "were these built from the same protocol source" — and is never used to refuse
a connection, because a build-plumbing fact must not be conflated with a protocol
incompatibility (ADR 2 D4).

**Why it is computed, never stamped into source.** It is a structural walk of the zod
schemas, performed at run time on whichever side is asking. Nothing generates it and
nothing is checked in, so there is no file anyone can forget to regenerate — and a
fingerprint that can go stale cannot detect staleness. A browser bundle and a compiled
server binary share no source tree, but they do both carry these schema objects.

## Runtime verification (2026-08-03, real server + real Chromium)

| Pairing | Result | Shot |
| --- | --- | --- |
| Fresh dist ↔ same-source server | no banner, no reload loop | `.artifacts/POD-1610/1-matched-pair-no-banner.png` |
| Dist stamped `0f1e2d3c…`, "built 2026-07-31T23:17" | server-injected banner naming the build date and both digests | `.artifacts/POD-1610/2-stale-dist-server-banner.png` |
| Dist with the stamp deleted (a pre-fix artefact) | server-injected "no build stamp" banner | curl, above |
| `/version` rewritten to a foreign digest by a proxy | client hard-reloads twice, then renders its own banner | `.artifacts/POD-1610/3-client-boot-digest-banner.png` |

The matched-pair run also proves the digest survives bundling: had the browser's computed
value differed from the server's, the guard would have reload-looped and banner'd.

## Not covered

- **The empty render itself was reproduced at the schema layer, not in a browser.** The
  double-failure and its flip are pinned deterministically in `feed.skew.test.ts`; the
  browser runs above verify the SIGNAL, not the emptiness. Reproducing a blank board end
  to end needs a seeded instance plus a genuinely old bundle, which is a slower rebuild of
  a fact the parser already decides.
- **An already-built stale bundle still cannot show the client banner.** It does not
  contain the component. That is the whole reason the server injects one.
- The mobile (Expo) dist is not stamped or graded; `stampCheck` is opt-in for the web dist
  only, since a permanent "unstamped" banner on a differently-built artefact is noise.
