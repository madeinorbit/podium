/**
 * The browser count layout, supplied entirely by the harness. happy-dom has
 * no box layout: give only the product list's scroll element the same box as
 * the browser lane (clientHeight selects the window, offsets size it).
 * Restore after unmount; ordinary count mounts keep the full-list layout.
 */
import { vi } from 'vitest'

export interface WindowLayout {
  readonly height: number
  readonly width: number
}

export function stubWindowLayout({ height, width }: WindowLayout): () => void {
  const mocks = (['clientHeight', 'offsetHeight', 'offsetWidth'] as const).map((property) => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)?.get
    return vi.spyOn(HTMLElement.prototype, property, 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.hasAttribute('data-pool-list')) return property === 'offsetWidth' ? width : height
      return original?.call(this) ?? 0
    })
  })
  return () => mocks.forEach((mock) => mock.mockRestore())
}
