# harness/native/ — the React Native count lane (POD-4445)

`control.native.test.tsx` mounts the legacy control's native list
(`mountNative()`, RN `View`/`Text`/`ScrollView`) in the React Native unit
renderer and runs the count harness over scenarios #1–#3 — the same
`runCountScenario` and `assertIsolation` as the web lane, the same heartbeat
failure shape.

Renderer: under this package's vitest config `react-native` resolves to
`react-native-web`, the same mapping `expo export -p web` builds against and
`apps/mobile/vitest.config.ts` uses. No DOM imports in the native list module
itself, so it also loads on device.

These suites are excluded from the root node/unit lanes (`nodeTestExclude` in
the root `vitest.config.ts` — React Native ships Flow source the node lane
cannot parse, the POD-1220 hazard) and run under the worklist-proto package
config — the same lane CI runs for this package:

```
bun run --filter @podium/worklist-proto test
```

H arms add their native lists here the same way: `handle.mountNative()`
through `mountNativeForCounts`, scenario writes from `shared/src/scenarios` (the one library, POD-4550),
parity against `snapshotFromStore`.

## Mc5: the round-three MobX pool on the native renderer (POD-4577)

`mobx-pool-fence.native.test.tsx` runs fence scenarios #1–#3 through the
shared `runFenceStep` on the pool's native `SectionList`, with counts from
outside (rows committed per `RowShell`, reads per change) plus parity, the
copy sweep, and window-aware commits: the redrawn rows must equal the
oracle-changed rows intersected with the resident drawn rows. `SectionList`
windowing under the test renderer draws the initial window from the top and
never grows it (no layout, no scroll), so commits — not rows rendered — are
the counted dimension. A planted whole-list list (every slot reads every
visible title) fails the count on #4, and the bootstrap cell reports the
observables the native mount builds on the lazy baseline (POD-4567, POD-4705).
`entries.test.ts` pins the native entry to `mobxPoolArm` with no renderer.

Renderer: `react-native` resolves to `react-native-web` under the
worklist-proto package config (the same mapping `expo export -p web` builds
against and `apps/mobile/vitest.config.ts` uses). The real React Native test
renderer is not a dependency of any repo lane — apps/mobile's lane provides no
real RN renderer either (no such dependency; its vitest config carries the
same react-native-web alias) — so Mc5 is the brief's "otherwise" branch: the
existing react-native-web lane, limitation stated.

Run through the package config (never `test:file`, which routes these files
to the node lane where they are excluded):

```
bun ../../scripts/validation-admission.ts focused -- bun --bun ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts harness/native/mobx-pool-fence.native.test.tsx
```
