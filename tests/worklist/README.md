# Pool test support

This private test workspace holds the shared pool test support: the reference state the screen checks compare against, the synthetic corpus, scenario engines, work meters and the pool tests built on them. Product entries do not import it. The legacy worklist derivation, its sidebar oracle and the prototype arms' parity machinery are deleted.

Run individual files through `bun run test:file -- tests/worklist/<path>`, or use `bun run test:lane -- worklist <paths>`. Both use the workspace config, including happy-dom and the work measurement plugins. The full package sweep schedules `@podium/worklist-tests#test`; its cache includes the product sources these tests read. The lean gate checks this wiring without executing the workspace. `bun run speed:structural` runs the pool screens' work ratios with their expected-failure ownership (`harness/src/screen-work.expected-failures.json`).

`harness/src/fixture` builds synthetic data, `shared/src/scenarios.ts` owns disposable scenario engines, `harness/src/work-meter.ts` counts work from outside product readers, and `diagnostics/` holds the per-screen reference checks. `arms/mobx/pool` keeps the renderer adapter over the product pool that the pool tests mount. `harness/lint` holds the fence ESLint plugin client-graph lints with.
