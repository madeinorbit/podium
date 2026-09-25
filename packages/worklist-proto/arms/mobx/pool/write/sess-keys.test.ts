import { describe, expect, it } from 'vitest'
import { buildCorpus } from '../../../../harness/src/fixture/index'
import { FIXTURE_SEED } from '../../../../shared/src/scenarios'

describe('ancestry', () => {
  it('prints parent chains', async () => {
    const corpus = buildCorpus(1, FIXTURE_SEED)
    const { appendFileSync } = await import('node:fs')
    const byId = new Map(
      (corpus.issues as unknown as { id: string; parentId: string | null }[]).map((w) => [w.id, w.parentId]),
    )
    const chain = (id: string): string => {
      const out = [id]
      let cur: string | null | undefined = byId.get(id)
      for (let i = 0; i < 12 && cur; i += 1) {
        out.push(cur)
        cur = byId.get(cur)
      }
      return out.join(' < ')
    }
    const sess = (corpus.sessions as unknown as { sessionId: string; issueId: string | null }[]).filter((s) =>
      ['s4275', 's4277'].includes(s.sessionId),
    )
    appendFileSync(
      '/tmp/sess-keys.txt',
      `s4275/77: ${JSON.stringify(sess)}\ni4368: ${chain('i4368')}\ni2696: ${chain('i2696')}\ni3150: ${chain('i3150')}\n`,
    )
    expect(true).toBe(true)
  })
})
