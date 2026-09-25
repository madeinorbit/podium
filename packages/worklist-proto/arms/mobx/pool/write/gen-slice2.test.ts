import { describe, expect, it } from 'vitest'
import { gen } from '../../../../shared/src/gen/changes'

describe('gen slice2', () => {
  it('prints seed 2 steps 0-95', async () => {
    const seq = gen(2, 270, {}, { editFields: ['title', 'readAt'] })
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      '/tmp/gen-slice2.txt',
      seq.slice(0, 95).map((c, i) => `${i} ${JSON.stringify(c)}`).join('\n') + '\n',
    )
    expect(true).toBe(true)
  })
})
