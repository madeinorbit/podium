/**
 * POD-7158 acceptance 1: no view asks the loader for an instance without
 * holding it.
 *
 * Holding follows reading (design POD-7157 "Layer 2: memory"): a view reads
 * a collection through the pool (`held`, `pageEnded`, `pageTotal`,
 * `treeHeld`, a lookup, `holdRecords`), and that read holds what it reads
 * while anything observes it. A direct `loader.request` or `loader.show`, or
 * the pool's former `collections.request` / `collections.show`, fetched
 * without a hold, or with a hold the view had to remember to release; the
 * deck and the board lost their data over the cache cap that way (POD-7155).
 *
 * Only the device store asks the loader directly: `packages/sync` (the loader
 * and the Replica), the pool's own `collections.ts`, and the composition
 * root that pipes the Replica's comes-with requests to the loader.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The device store's own files: they may ask the loader directly. */
const DEVICE_STORE = [
  'packages/sync/',
  'packages/client-graph/src/collections.ts',
  // The Replica's comes-with requests, piped to the loader (the composition root).
  'packages/client-core/src/replica-assembly/assembly.ts',
]

/**
 * A call that asks the loader for an instance: the loader's `request`,
 * `show` or `requestRecords`, however the loader is reached, or the pool's
 * collections' `request`, `show` or `adopt`.
 */
const LOADER_CALL =
  /\bloader\s*(?:\??\.?\s*\(\s*\))?\s*\??\.\s*(?:request|show|requestRecords)\s*\(|\bcollections\s*\??\.\s*(?:request|show|adopt)\s*\(/g

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (['test', 'tests', '__tests__', '__fixtures__', 'harness', 'test-support'].includes(name))
        continue
      sourceFiles(path, out)
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.(test|spec)\.tsx?$|\.fixture\.ts$|\.d\.ts$/.test(name)
    )
      out.push(path)
  }
  return out
}

/** Each call outside the device store's files, as `file:line: text`. */
function loaderCallsOutsideTheStore(): string[] {
  const found: string[] = []
  for (const top of ['apps', 'packages'])
    for (const file of sourceFiles(join(ROOT, top))) {
      const path = relative(ROOT, file)
      if (DEVICE_STORE.some((allowed) => path === allowed || path.startsWith(allowed))) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, at) => {
        LOADER_CALL.lastIndex = 0
        if (LOADER_CALL.test(line)) found.push(`${path}:${at + 1}: ${line.trim()}`)
      })
    }
  return found
}

describe('views read through the pool; only the device store asks the loader (POD-7158)', () => {
  it('no file outside the device store asks the loader for an instance', () => {
    expect(loaderCallsOutsideTheStore(), 'loader calls outside the device store').toEqual([])
  })

  it('is armed: each way of asking the loader is found', () => {
    const found = (line: string) => {
      LOADER_CALL.lastIndex = 0
      return LOADER_CALL.test(line)
    }
    expect(found("pool.collections.request([pageOf(options)], 'visible')")).toBe(true)
    expect(found('const release = this.pool.collections.show(PROPOSED_PAGE)')).toBe(true)
    expect(found("this.pool.collections.adopt('issue', ids)")).toBe(true)
    expect(found("loader.request([spec], 'visible')")).toBe(true)
    expect(found('replica.loader?.()?.show(spec)')).toBe(true)
    expect(found('this.loader()?.show(spec)')).toBe(true)
    expect(found('loader?.requestRecords(kind, ids)')).toBe(true)
    // Held reads are what views use.
    expect(found('pool.collections.pageEnded(spec)')).toBe(false)
    expect(found("pool.collections.holdRecords('issue', ids)")).toBe(false)
  })
})
