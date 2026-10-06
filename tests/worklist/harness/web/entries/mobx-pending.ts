/** POD-4825: the MobX pool with its write layer, pending (`writable-page.ts`). */
import { bootWritablePage } from './writable-page'

// POD-4561: the bundle is fetched, parsed and evaluated (every static import).
const scriptAt = performance.now()

bootWritablePage('pending', scriptAt)
