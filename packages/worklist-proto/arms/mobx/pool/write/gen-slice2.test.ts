import { describe, expect, it } from 'vitest'
import { gen } from '../../../../shared/src/gen/changes'

describe('gen slice2', () => {
  it('prints seed 4 steps 80-95', async () => {
    const seq = gen(4, 95, {}, { editFields: ['title', 'readAt'] })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      '/tmp/gen-slice4.txt',
      seq.slice(80, 95).map((c, i) => `${80 + i} ${JSON.stringify(c)}`).join('\n') + '\n',
    )
    expect(true).toBe(true)
  })
})
