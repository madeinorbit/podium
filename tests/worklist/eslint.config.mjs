/**
 * POD-4563 (L6a) — the package's lint: the fence rules over every arm folder
 * (`harness/lint/`). `hand` is the frozen round-two arm: only the wall-clock
 * rule applies to it. Every other folder under `arms/` is a round-three arm
 * and must carry `fence.json` (the `arm-manifest` rule). `arms/mobx` is the
 * round-three MobX pool (POD-4565) directly: its fence.json declares the
 * pool modules, and every fence rule applies to them. `hand/pool` is the
 * round-three hand-rolled pool (POD-4578) inside the frozen `hand` folder,
 * thawed against `arms/hand/fence.json`, plus the import fence that keeps it
 * from importing the frozen round-two files. (The MobX pool needed the same
 * thaw while the frozen round-two MobX arm shared its folder; POD-4749
 * deleted that arm, so the folder is thawed no longer.)
 *
 * The MobX arm's own rules stay in `arms/mobx/eslint.config.mjs`; `bun run
 * lint` runs both.
 */

import { fenceConfig } from './harness/lint/fence-plugin.mjs'

export default fenceConfig({ root: 'arms', frozen: ['hand'], thawed: ['hand/pool'] })
