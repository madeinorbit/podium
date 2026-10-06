/** Fence rules for the retained worklist test arms. */
import { fenceConfig } from './harness/lint/fence-plugin.mjs'

export default fenceConfig({ root: 'arms', frozen: [], thawed: [] })
