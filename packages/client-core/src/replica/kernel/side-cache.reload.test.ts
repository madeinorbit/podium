import { describe, expect, it } from 'vitest'
import { memoryStorage } from '../contract'
import { createSideCache } from './side-cache'

describe('draft storage checkpoint before reload', () => {
  it('reports a refused ordinary UI write, retaining it in memory until a successful checkpoint', () => {
    const storage = memoryStorage()
    let denied = true
    const side = createSideCache({
      storage: {
        ...storage,
        setItem: (key, value) => {
          if (denied) throw new Error('QuotaExceededError')
          storage.setItem(key, value)
        },
      },
      enumerateKeys: () => [],
    })
    const ui = side.uiState()
    ui.set('draft', 'keep the final keystroke')
    expect(() => ui.flush?.()).toThrow('QuotaExceededError')
    expect(ui.get('draft')).toBe('keep the final keystroke')
    denied = false
    ui.flush?.()
    const reopened = createSideCache({ storage, enumerateKeys: () => [] })
    expect(reopened.uiState().get('draft')).toBe('keep the final keystroke')
  })
})
