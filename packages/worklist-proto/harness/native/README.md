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
