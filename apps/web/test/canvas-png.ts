import { afterEach, beforeEach, type MockInstance, vi } from 'vitest'

// DOM emulators cannot draw/encode canvas pixels. Keep the real working-mark
// runtime and APNG assembly in component tests, with a valid transparent PNG at
// the raster boundary. Real-browser evidence verifies the actual picture.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII='
let context: MockInstance | undefined
let png: MockInstance | undefined

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') return
  context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  png = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(PNG)
})

afterEach(() => {
  context?.mockRestore()
  png?.mockRestore()
})
