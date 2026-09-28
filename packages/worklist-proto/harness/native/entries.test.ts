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
import { mobxPoolArm } from '../../arms/mobx/pool/arm'
import { moduleGraphOf } from '../entry-pin'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')

function poolArm(): string {
  return readFileSync(join(PACKAGE_DIR, 'arms/mobx/pool/arm.ts'), 'utf-8')
}

function nativeList(): string {
  return readFileSync(join(PACKAGE_DIR, 'arms/mobx/pool/native/list.tsx'), 'utf-8')
}

describe('native entry mounts the round-three MobX pool', () => {
  it('pool arm exposes mountNative from the pool native list', () => {
    const code = poolArm()
    expect(code, 'the pool arm value').toContain('mobxPoolArm')
    expect(code, 'the native list chunk').toContain('./native/list')
    expect(code, 'the native entry').toContain('mountNative')
  })

  it('pool native list is the windowed SectionList over pool models', () => {
    const code = nativeList()
    expect(code, 'windowed by SectionList').toContain('SectionList')
    expect(code, 'rows through the enforcing shell').toContain('RowShell')
    expect(code, 'not the unenforcing boundary').not.toContain('CommitBoundary')
  })

  it('the pool arm module reaches the native list', () => {
    // By module, not by spelling (POD-4577: a text grep misses a relative
    // import of the same file). Renderer-free: the graph walk reads source,
    // it never executes arm code.
    const graph = moduleGraphOf(join(PACKAGE_DIR, 'arms/mobx/pool/arm.ts'))
    expect(graph, 'the native entry').toContain(join(PACKAGE_DIR, 'arms/mobx/pool/native/list.tsx'))
  })

  it('the mounted arm is mobxPoolArm by identity', () => {
    // The fence lane mounts the export of `arms/mobx/pool/arm` (same path,
    // so the same module instance).
    expect(mobxPoolArm, 'the pool arm export').toBeDefined()
    expect(typeof mobxPoolArm.create, 'mobxPoolArm.create').toBe('function')
  })
})
