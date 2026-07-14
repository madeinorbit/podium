import { describe, expect, it } from 'vitest'
import { verifiedBundleBases } from './handoff-transfer'

describe('verifiedBundleBases', () => {
  it('keeps only unique SHAs proven by successful target rev-parse calls', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    expect(
      verifiedBundleBases([
        { ok: true, output: a },
        { ok: false, output: b },
        { ok: true, output: `${a}\n${b}` },
      ]),
    ).toEqual([a, b])
  })
})
