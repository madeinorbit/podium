import { describe, expect, it } from 'vitest'
import { verifiedBundleBases, verifiedCommonBundleBases } from './handoff-transfer'

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

describe('verifiedCommonBundleBases', () => {
  it('keeps a source base proven by the target even when their branch tips differ', () => {
    const shared = 'a'.repeat(40)
    const sourceTip = 'b'.repeat(40)
    const targetTip = 'c'.repeat(40)

    expect(
      verifiedCommonBundleBases(
        [
          { ok: true, output: sourceTip },
          { ok: true, output: shared },
        ],
        [
          { ok: false, output: sourceTip },
          { ok: true, output: shared },
          { ok: true, output: targetTip },
        ],
      ),
    ).toEqual([shared])
  })
})
