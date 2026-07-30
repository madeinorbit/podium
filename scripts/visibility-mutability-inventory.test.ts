/**
 * The committed inventory must match the matrix. Same discipline as
 * `migration:manifest --check`: a generated artifact that is allowed to drift
 * is worse than no artifact, because POD-1077 would plan against a stale list.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { OWNERSHIP_MATRIX } from '../packages/model/src/annotations/matrix'
import { OUTPUT_PATH, render } from './visibility-mutability-inventory'

describe('visibility mutability inventory', () => {
  it('is not stale against the ownership matrix', () => {
    expect(readFileSync(OUTPUT_PATH, 'utf8')).toBe(render())
  })

  it('lists every matrix row exactly once', () => {
    // The instrument check: a document that silently dropped rows would still
    // match `render()` above, so assert coverage against the matrix itself.
    const doc = readFileSync(OUTPUT_PATH, 'utf8')
    for (const row of OWNERSHIP_MATRIX) {
      const occurrences = doc.split(`\`${row.id}\` |`).length - 1
      expect(occurrences, `${row.id} appears ${occurrences} times`).toBe(1)
    }
  })

  it('would notice a row moving between the two sections', () => {
    // Mutation-style probe on the RENDERER rather than the product: flip one
    // row's mutability and require the output to change. Without this, "the doc
    // matches" could hold for a renderer that ignored the column entirely.
    const flipped = OWNERSHIP_MATRIX.map((row) =>
      row.id === OWNERSHIP_MATRIX[0]?.id
        ? { ...row, visibilityMutability: { mutable: true, verbs: ['share'] as const, note: 'probe' } }
        : row,
    )
    expect(render(flipped)).not.toBe(render())
  })
})
