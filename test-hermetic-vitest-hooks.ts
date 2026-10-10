import { afterEach, beforeEach, expect } from 'vitest'
import { assertHermeticStateDir } from './test-hermetic-state-guard'

beforeEach(() => assertHermeticStateDir())
afterEach(() => assertHermeticStateDir())

// Web components use the real working-mark runtime in a DOM emulator, which
// cannot encode canvas pixels. Load its raster seam through this existing setup
// entry point; keep other lanes and the shared setup-file contract unchanged.
if (expect.getState().testPath?.replaceAll('\\', '/').includes('/apps/web/')) {
  const { installCanvasPngHooks } = await import('./apps/web/test/canvas-png')
  installCanvasPngHooks()
}
