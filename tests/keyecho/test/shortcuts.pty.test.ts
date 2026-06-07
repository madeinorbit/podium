import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Keyecho, bootKeyecho } from './driver.js'
import { SHORTCUTS } from './shortcuts.js'

describe('keyecho echoes Claude Code shortcuts through a real PTY (raw mode)', () => {
  let app: Keyecho
  beforeAll(async () => {
    app = bootKeyecho(['--mode', 'raw'])
    await app.waitFor((t) => t.includes('keyecho') && t.includes('mode='), 15000)
  }, 20000)
  afterAll(() => app?.dispose())

  for (const s of SHORTCUTS) {
    it(
      `echoes ${s.name}`,
      async () => {
        app.send(s.bytes)
        await app.waitFor((t) => t.includes(s.expectLabel))
        expect(app.text()).toContain(s.expectLabel)
      },
      8000,
    )
  }
})

describe('both mode shows raw and ink for the same keypress', () => {
  it(
    'Ctrl+C appears tagged [raw] and [ink]',
    async () => {
      const app = bootKeyecho(['--mode', 'both'])
      try {
        await app.waitFor((t) => t.includes('mode='), 15000)
        app.send('\x03')
        await app.waitFor((t) => t.includes('[raw]') && t.includes('[ink]'), 8000)
        const t = app.text()
        expect(t).toContain('[raw]')
        expect(t).toContain('[ink]')
      } finally {
        app.dispose()
      }
    },
    25000,
  )
})
