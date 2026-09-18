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
Raw aggregate results are in `results/`; generated bundles are ignored. The
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
