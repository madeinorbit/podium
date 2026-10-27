# Worklist test support

This private test workspace holds the retained worklist corpus, correctness oracle, work meters, scenario engines and pool regression harness. Product entries do not import it. The retired hand arm and its tracking baseline are deleted.

Run individual files through `bun run test:file -- tests/worklist/<path>`, or use `bun run test:lane -- worklist <paths>`. Both use the workspace config, including happy-dom, work measurement plugins and the React Native web renderer alias. The full package sweep schedules `@podium/worklist-tests#test`; its cache includes the product sources these tests read. The lean gate checks this wiring without executing the workspace. The structural command retains the existing MobX reader bounds and expected-failure ownership.

`harness/src/fixture` builds synthetic data, `shared/src/scenarios.ts` owns disposable scenario engines, and `harness/src/work-meter.ts` counts work from outside product readers. `arms/mobx` contains pool regression tests and renderer adapters over the product module factories. The lean comparison wrapper imported the deleted hand implementation and was retired with it.
