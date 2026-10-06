// POD-4694 — the browser pages mount the round-three pools, never the
// frozen round-two arms. The hand page mounted `handArm` (the round-two
// `HandStore`, with its known correctness bugs) while the matrix timed it as
// the round-three pool: every record mismatched the oracle from bootstrap
// (i1026 queued/false vs waiting/true), identically at the base SHA. This
// test pins each candidate entry to its pool arm without Chromium: it fails
// on the round-two import and passes on the pool one.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { moduleGraphOf } from '../entry-pin'

const PACKAGE_DIR = process.cwd().endsWith(join('tests', 'worklist'))
  ? process.cwd()
  : join(process.cwd(), 'tests', 'worklist')

function entry(name: string): string {
  return readFileSync(join(PACKAGE_DIR, 'harness/web/entries', `${name}.ts`), 'utf-8')
}

describe('browser entries mount the round-three pools', () => {

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
      resolve(PACKAGE_DIR, '@podium/client-graph/pool.ts'),
    )
  })

  it('mobx-write and mobx-pending resolve to the harness arm over the product pool and its transaction log (POD-4825, POD-4944, POD-5432)', () => {
    for (const name of ['mobx-write', 'mobx-pending']) {
      const graph = moduleGraphOf(join(PACKAGE_DIR, `harness/web/entries/${name}.ts`))
      expect(graph, `${name}: the harness adapter`).toContain(
        join(PACKAGE_DIR, 'harness/src/adapters/mobx-pool.ts'),
      )
      expect(graph, `${name}: the product pool under the adapter`).toContain(
        resolve(PACKAGE_DIR, '@podium/client-graph/pool.ts'),
      )
      // POD-5432: the arm owns optimism through the product's transaction log.
      expect(graph, `${name}: the product transaction log`).toContain(
        resolve(PACKAGE_DIR, '@podium/client-graph/write/transactions.ts'),
      )
    }
  })

})
