import { describe, expect, it } from 'vitest'
import { classifyPickerFailure } from './composer-picker-errors'

describe('native picker failures', () => {
  it('keeps cancellation silent but makes permission denial actionable', () => {
    expect(classifyPickerFailure('Photos', { code: 'ERR_PICKER_CANCELLED' })).toEqual({
      cancelled: true,
    })
    expect(classifyPickerFailure('Files', new Error('Permission denied'))).toEqual({
      cancelled: false,
      message: 'Files access was denied. Allow access in Settings, then try again.',
    })
  })
})
