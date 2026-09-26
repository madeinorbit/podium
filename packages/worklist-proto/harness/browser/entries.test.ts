// POD-4694 — the browser pages mount the round-three pools, never the
// frozen round-two arms. The hand page mounted `handArm` (the round-two
// `HandStore`, with its known correctness bugs) while the matrix timed it as
// the round-three pool: every record mismatched the oracle from bootstrap
// (i1026 queued/false vs waiting/true), identically at the base SHA. This
// test pins each candidate entry to its pool arm without Chromium: it fails
// on the round-two import and passes on the pool one.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

function entry(name: string): string {
  return readFileSync(join(PACKAGE_DIR, 'harness/web/entries', `${name}.ts`), 'utf-8')
}

describe('browser entries mount the round-three pools', () => {
  it('hand mounts handPoolArm with the pool parity allowance', () => {
    const code = entry('hand')
    expect(code, 'the round-three pool arm').toContain('arms/hand/pool/arm')
    expect(code, 'the pool arm value').toContain('handPoolArm')
    expect(code, 'the pool parity allowance').toContain('HAND_POOL_ALLOWANCES')
    expect(code, 'not the round-two arm').not.toContain('arms/hand/arm')
    expect(code, 'not the round-two store').not.toContain('HandStore')
  })

  it('mobx mounts mobxPoolArm with the pool parity allowance', () => {
    const code = entry('mobx')
    expect(code, 'the round-three pool arm').toContain('arms/mobx/pool/arm')
    expect(code, 'the pool arm value').toContain('mobxPoolArm')
    expect(code, 'the pool parity allowance').toContain('MOBX_POOL_ALLOWANCES')
  })
})
