# Worklist test support

This private test workspace holds the retained worklist corpus, correctness oracle, work meters, scenario engines and pool regression harness. Product entries do not import it. The retired hand arm and its tracking baseline are deleted.

Run individual files through `bun run test:file -- tests/worklist/<path>`. Native files route through the workspace config, which aliases React Native to its web test renderer. The structural command retains the existing MobX reader bounds and expected-failure ownership.

`harness/src/fixture` builds synthetic data, `shared/src/scenarios.ts` owns disposable scenario engines, and `harness/src/work-meter.ts` counts work from outside product readers. `arms/mobx` contains pool regression tests and renderer adapters over the product module factories. The lean comparison wrapper imported the deleted hand implementation and was retired with it.
