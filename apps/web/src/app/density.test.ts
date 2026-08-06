import { afterEach, describe, expect, it } from 'vitest'
import { applyDensity, readStoredDensity, SHELL_DENSITY_KEY } from './density'

afterEach(() => localStorage.clear())

describe('shell density', () => {
  it('defaults to balanced and reads compact explicitly', () => {
    expect(readStoredDensity()).toBe('balanced')
    localStorage.setItem(SHELL_DENSITY_KEY, 'compact')
    expect(readStoredDensity()).toBe('compact')
  })

  it('treats unknown values as balanced', () => {
    localStorage.setItem(SHELL_DENSITY_KEY, 'tiny')
    expect(readStoredDensity()).toBe('balanced')
  })

  it('applies the density as root document state', () => {
    const root = document.createElement('html')
    applyDensity('balanced', root)
    expect(root.dataset.density).toBe('balanced')
    applyDensity('compact', root)
    expect(root.dataset.density).toBe('compact')
  })
})
