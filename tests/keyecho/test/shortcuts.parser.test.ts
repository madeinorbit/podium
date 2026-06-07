import { describe, expect, it } from 'vitest'
import { decodeInput } from '../src/parser.js'
import { SHORTCUTS } from './shortcuts.js'

describe('shortcuts decode at the parser level', () => {
  for (const s of SHORTCUTS) {
    it(`${s.name} → "${s.expectLabel}"`, () => {
      const { events, rest } = decodeInput(Buffer.from(s.bytes, 'latin1'))
      expect(rest.length, `leftover bytes for ${s.name}`).toBe(0)
      expect(events.length, `no event for ${s.name}`).toBeGreaterThan(0)
      const labels = events.map((e) => e.label).join(' | ')
      expect(labels, `got "${labels}" for ${s.name}`).toContain(s.expectLabel)
    })
  }
})
