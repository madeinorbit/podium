import { describe, expect, it, vi } from 'vitest'
import { applyDensity, readStoredDensity, SHELL_DENSITY_KEY } from './density'

function uiState(value: string | null) {
  return { get: vi.fn(() => value) }
}

describe('shell density', () => {
  it('defaults to balanced and reads compact explicitly', () => {
    expect(readStoredDensity(uiState(null))).toBe('balanced')
    const compact = uiState('compact')
    expect(readStoredDensity(compact)).toBe('compact')
    expect(compact.get).toHaveBeenCalledWith(SHELL_DENSITY_KEY)
  })

  it('treats unknown values as balanced', () => {
    expect(readStoredDensity(uiState('tiny'))).toBe('balanced')
  })

  it('applies the density as root document state', () => {
    const root = document.createElement('html')
    applyDensity('balanced', root)
    expect(root.dataset.density).toBe('balanced')
    applyDensity('compact', root)
    expect(root.dataset.density).toBe('compact')
  })
})
