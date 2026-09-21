import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { fileIdFor } from './file-chain'

it('keeps fixed-width hashes while deriving active and archived namespaces from session identity', () => {
  const session = 'native-session'
  for (const sequence of [undefined, 1, 2]) {
    const input = sequence === undefined ? session : `${session}\0${sequence}`
    const expected = createHash('sha1').update(input).digest('hex').slice(0, 12)
    expect(fileIdFor(session, sequence)).toBe(expected)
    expect(fileIdFor(session, sequence)).toBe(fileIdFor(session, sequence))
    expect(fileIdFor(session, sequence)).toMatch(/^[a-f0-9]{12}$/)
  }
  // Archives represent retired generations, even when their bytes equal the active file.
  expect(fileIdFor(session, 1)).not.toBe(fileIdFor(session))
  expect(fileIdFor(session, 1)).not.toBe(fileIdFor(session, 2))
  expect(fileIdFor(session, 1)).not.toBe(fileIdFor(JSON.stringify([session, 1])))
})
