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
import { moduleGraphOf } from '../entry-pin'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

function entry(name: string): string {
  return readFileSync(join(PACKAGE_DIR, 'harness/web/entries', `${name}.ts`), 'utf-8')
}

describe('browser entries mount the round-three pools', () => {
  it('hand mounts handPoolArm with no parity allowance (POD-4671 fixed)', () => {
    const code = entry('hand')
    expect(code, 'the round-three pool arm').toContain('arms/hand/pool/arm')
    expect(code, 'the pool arm value').toContain('handPoolArm')
    expect(code, 'no parity allowance').not.toContain('HAND_POOL_ALLOWANCES')
    expect(code, 'not the round-two arm').not.toContain('arms/hand/arm')
    expect(code, 'not the round-two store').not.toContain('HandStore')
  })

  it('mobx mounts harnessMobxPoolArm with no parity allowance (POD-4671 fixed)', () => {
    const code = entry('mobx')
    expect(code, 'the harness pool adapter').toContain('src/adapters/mobx-pool')
    expect(code, 'the harness arm value').toContain('harnessMobxPoolArm')
    expect(code, 'no parity allowance').not.toContain('MOBX_POOL_ALLOWANCES')
    expect(code, 'not the product arm directly').not.toContain('arms/mobx/pool/arm')
  })

  it('mobx web entry resolves to the harness adapter over the product pool', () => {
    // By module, not by spelling (POD-4577: the native pin's text grep missed
    // a relative import of the same file). Renderer-free: the graph walk
    // reads source, it never executes arm code, so this also runs in lanes
    // without the native alias.
    const graph = moduleGraphOf(join(PACKAGE_DIR, 'harness/web/entries/mobx.ts'))
    expect(graph, 'the harness adapter').toContain(
      join(PACKAGE_DIR, 'harness/src/adapters/mobx-pool.ts'),
    )
    expect(graph, 'the product pool under the adapter').toContain(
      join(PACKAGE_DIR, 'arms/mobx/pool/pool.ts'),
    )
  })

  it('mobx-write and mobx-pending resolve to the pool with its write layer (POD-4825)', () => {
    for (const name of ['mobx-write', 'mobx-pending']) {
      const graph = moduleGraphOf(join(PACKAGE_DIR, `harness/web/entries/${name}.ts`))
      expect(graph, `${name}: the writable arm`).toContain(
        join(PACKAGE_DIR, 'arms/mobx/pool/write/arm.ts'),
      )
      expect(graph, `${name}: its overlay`).toContain(
        join(PACKAGE_DIR, 'arms/mobx/pool/write/overlay.ts'),
      )
    }
  })

  it('hand web entry resolves to the pool arm, never the round-two arm', () => {
    // By module, not by spelling: this is the page that mounted `handArm`
    // (the round-two `HandStore`) while the matrix timed it as the
    // round-three pool (dacdf9d98). Same graph assertion as the MobX entry.
    const graph = moduleGraphOf(join(PACKAGE_DIR, 'harness/web/entries/hand.ts'))
    expect(graph, 'the pool arm').toContain(join(PACKAGE_DIR, 'arms/hand/pool/arm.ts'))
    expect(
      graph.filter((file) => file === join(PACKAGE_DIR, 'arms/hand/arm.ts')),
      'the round-two arm, however it is spelled',
    ).toEqual([])
  })
})
