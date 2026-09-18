# Reactive candidate proof

Isolated proof for POD-4321. No application entry imports this directory.
Comparison baseline: `docs/measurements/POD-4358-post-b-baseline.md`.
The decision remains open until both candidates have measurements and build evidence.

Run from the repository root with pinned Bun:

```sh
bun scripts/test-heavy.ts -- bun packages/client-core/proofs/d1/validate.ts
```

This sequential lane runs scoped client typechecks, the exact web/mobile proof
files, isolated Vite/Expo web/iOS/Android bundles and the ordinary client builds.
Generated results and bundles are ignored under `results/`; the reviewed snapshot
is retained in `docs/measurements/POD-4321-reactive-proof.json`. The
mobile unit renderer uses react-native-web, so it does not establish device
latency. Expo native bundling checks the RN module graph, not an installed app.

The fixture uses A3's 4,867 issues / 4,304 sessions and doubled growth rescope.
Five-member formal families, mixed phases, a pinned row and an expiring defer
make the requested derived work observable. Both variants invoke the unchanged
mission rollup and provenance/nesting functions over the same 200-issue group.
This exposes their arbitrary-JavaScript remainder rather than inventing a
simplified mission algorithm and calling it native. Operation counters count
wrapper visits and calls; they do not claim to count internal library steps.

The harness is experimental comparison code, not a production library adapter.
Remove this directory and its two app test entries to disable it. Revert the
manifest/lockfile edits to remove the candidate dependency upgrade.

The runner sets `PODIUM_D1_PROOF=1`; ordinary unit runs skip this expensive
comparison and do not rewrite measurements. The fresh-process memory step is
necessary because sequential test-process heap deltas can be negative when old
cases are collected. Only `results/memory.json` is used to compare retained heap.

TanStack source and derived join keys have explicit BasicIndex indexes. Cleanup
runs from dependent queries back to their sources; a source-first armed control
checks that the lifecycle assertion can detect the reversed order. The native
query engine's internal operator count is not exposed: `nativeOutputChanges`
counts output records, not hidden dataflow operations.

## Hand-written comparison (D7)

The third arm, `keyed.tsx`, uses plain immutable Maps, subscriber sets and
`useSyncExternalStore`, with no added dependency. Run just MobX and keyed through
the same suite, memory harness and bundle builder:

```sh
bun scripts/test-heavy.ts -- bun packages/client-core/proofs/d1/validate-d7.ts
```

`PODIUM_D7_PROOF=1` selects those two arms; D1's default now includes all three.
The armed coarse control is unchanged. The D7 runner also requires and sets
`PODIUM_D1_PROOF=1`, so ordinary tests still skip all expensive comparisons.
See [the D7 decision](../../../../docs/decisions/4364-keyed-store-comparison.md)
for measurements, cache boundaries, interpretation and the disable path.
