import { describe, expect, it } from 'vitest'
import { canSave } from './editor-save'

describe('canSave', () => {
  it('is true only when editable, dirty, and not saving', () => {
    expect(canSave({ editable: true, dirty: true, saving: false })).toBe(true)
    expect(canSave({ editable: false, dirty: true, saving: false })).toBe(false)
    expect(canSave({ editable: true, dirty: false, saving: false })).toBe(false)
    expect(canSave({ editable: true, dirty: true, saving: true })).toBe(false)
  })
})
