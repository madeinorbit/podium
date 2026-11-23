import { describe, expect, it } from 'vitest'
import { browserHostileSources } from '../apps/web/test/web-bundle-boundaries'

describe('browser bundle boundary', () => {
  it('allows the declared browser entrypoint and its pure cursor dependency chain', () => {
    expect(
      browserHostileSources([
        '../../../../packages/harness/src/browser.ts',
        '../../../../packages/harness/src/store/stream-identity.ts',
        '../../../../packages/harness/src/store/cursor-codec.ts',
        '../../../../packages/harness/src/transcript-types.ts',
        'C:\\repo\\packages\\harness\\src\\transcript-types.ts',
      ]),
    ).toEqual([])
  })

  it('still rejects host modules, unknown harness leaves and names extending an exception', () => {
    const hostile = [
      'packages/harness/src/metadata.ts',
      'packages/harness/src/store/source.ts',
      'packages/harness/src/driver/families/terminal/runtime.ts',
      'packages/harness/src/transcript-reader.ts',
      'packages/harness/src/transcript-types.ts.host.ts',
      'C:\\repo\\packages\\runtime\\src\\sqlite\\database.ts',
      'apps/web/src/file-viewer-replay.ts',
    ]
    expect(
      browserHostileSources([...hostile, ...hostile, 'packages/model/src/browser.ts']),
    ).toEqual([...hostile].sort())
  })
})
