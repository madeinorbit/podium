/**
 * POD-4563 (L6a) — the package's lint: the fence rules over every arm folder
 * (`harness/lint/`). `hand` and `mobx` are the frozen round-two arms: only the
 * wall-clock rule applies to them. Every other folder under `arms/` is a
 * round-three arm and must carry `fence.json` (the `arm-manifest` rule).
 *
 * The MobX arm's own rules stay in `arms/mobx/eslint.config.mjs`; `bun run
 * lint` runs both.
 */

import { fenceConfig } from './harness/lint/fence-plugin.mjs'

export default fenceConfig({ root: 'arms', frozen: ['hand', 'mobx'] })
