// packages/protocol/src/file-asset-messages.test.ts
import { describe, expect, it } from 'vitest'
import { ControlMessage, DaemonMessage } from './messages'

describe('file asset messages', () => {
  it('accepts a fileAssetRequest in ControlMessage', () => {
    const m = ControlMessage.parse({
      type: 'fileAssetRequest', requestId: 'fa1', cwd: '/w', path: '/w/a.png', knownPath: false,
    })
    expect(m.type).toBe('fileAssetRequest')
  })
  it('accepts a fileAssetResult in DaemonMessage', () => {
    const m = DaemonMessage.parse({
      type: 'fileAssetResult', requestId: 'fa1', ok: true, path: '/w/a.png',
      dataBase64: 'AAAA', contentType: 'image/png',
    })
    expect(m.ok).toBe(true)
    if (m.type === 'fileAssetResult') expect(m.contentType).toBe('image/png')
  })
})
