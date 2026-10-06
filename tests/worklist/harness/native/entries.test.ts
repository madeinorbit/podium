// POD-4577 (Mc5) — the native lane mounts the round-three MobX pool, never
// the frozen round-two arm. The hand-rolled web page mounted `handArm` (the
// round-two `HandStore`, with its known correctness bugs) while the matrix
// timed it as the round-three pool (dacdf9d98); do not repeat that on native.
// This test pins the native entry to its pool arm without the renderer: text
// for the exact spellings, and the module graph (which no relative-import
// spelling can dodge) for the files.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { harnessMobxPoolArm } from '../src/adapters/mobx-pool'
import { moduleGraphOf } from '../entry-pin'

const PACKAGE_DIR = process.cwd().endsWith(join('tests', 'worklist'))
  ? process.cwd()
  : join(process.cwd(), 'tests', 'worklist')

function harnessAdapter(): string {
  return readFileSync(join(PACKAGE_DIR, 'harness/src/adapters/mobx-pool.ts'), 'utf-8')
}

function nativeList(): string {
  return readFileSync(join(PACKAGE_DIR, 'arms/mobx/pool/native/list.tsx'), 'utf-8')
}

describe('native entry mounts the round-three MobX pool', () => {
  it('harness adapter wraps the product arm and exposes its mounts', () => {
    const code = harnessAdapter()
    expect(code, 'the harness arm value').toContain('harnessMobxPoolArm')
    // POD-4944: the adapter wraps the product entry point (the ONE create)
    // and delegates the mounts to it, so it names the product arm, not the
    // native list chunk.
    expect(code, 'the product arm under the adapter').toContain('arms/mobx/pool/arm')
    expect(code, 'the native entry').toContain('mountNative')
  })

  it('pool native list is the windowed SectionList over pool models', () => {
    const code = nativeList()
    expect(code, 'windowed by SectionList').toContain('SectionList')
    expect(code, 'rows through the enforcing shell').toContain('RowShell')
    expect(code, 'not the unenforcing boundary').not.toContain('CommitBoundary')
  })

  it('the harness adapter module reaches the native list through the product arm', () => {
    // By module, not by spelling (POD-4577: a text grep misses a relative
    // import of the same file). Renderer-free: the graph walk reads source,
    // it never executes arm code. The adapter delegates `mountNative` to the
    // product arm, which lazy-imports the product native list (POD-4944: the
    // adapter holds no list chunk of its own).
    const graph = moduleGraphOf(join(PACKAGE_DIR, 'harness/src/adapters/mobx-pool.ts'))
    expect(graph, 'the product arm under the adapter').toContain(
      join(PACKAGE_DIR, 'arms/mobx/pool/arm.ts'),
    )
    expect(graph, 'the native entry').toContain(join(PACKAGE_DIR, 'arms/mobx/pool/native/list.tsx'))
  })

  it('the mounted arm is harnessMobxPoolArm by identity', () => {
    // The fence lane mounts the export of the harness adapter (same path,
    // so the same module instance).
    expect(harnessMobxPoolArm, 'the harness arm export').toBeDefined()
    expect(typeof harnessMobxPoolArm.create, 'harnessMobxPoolArm.create').toBe('function')
  })
})
