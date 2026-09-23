/**
 * POD-4563 (L6a) — the package's lint: the fence rules over every arm folder
 * (`harness/lint/`). `hand` and `mobx` are the frozen round-two arms: only the
 * wall-clock rule applies to them. Every other folder under `arms/` is a
 * round-three arm and must carry `fence.json` (the `arm-manifest` rule).
 * `mobx/pool` is the round-three MobX pool (POD-4565) inside the frozen
 * folder: thawed, so every fence rule applies to it against
 * `arms/mobx/fence.json`, plus the import fence that keeps it from importing
 * the frozen round-two files. `hand/pool` is the round-three hand-rolled pool
 * (POD-4578) inside the frozen `hand` folder, thawed the same way against
 * `arms/hand/fence.json`.
 *
 * The MobX arm's own rules stay in `arms/mobx/eslint.config.mjs`; `bun run
 * lint` runs both.
 */

import { fenceConfig } from './harness/lint/fence-plugin.mjs'

export default fenceConfig({ root: 'arms', frozen: ['hand', 'mobx'], thawed: ['mobx/pool', 'hand/pool'] })
