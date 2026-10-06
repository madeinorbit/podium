/** The kernel facade and client contract must not depend on a store library. */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every `.ts` under `dir`, recursively, as [relativePath, contents]. */
function sources(dir: string, prefix = ''): [string, string][] {
  const out: [string, string][] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...sources(abs, rel))
    else if (entry.name.endsWith('.ts')) out.push([rel, readFileSync(abs, 'utf8')])
  }
  return out
}

/**
 * Comments stripped FIRST, and this file learned that the hard way.
 *
 * The first version of this guard matched raw source, and `contract.ts`'s own
 * header quotes the offending line it exists to explain:
 *
 *     replica.ts   import type { StorageApi, … } from '@tanstack/db'
 *
 * So the guard failed on the documentation OF the fix. That is the repo's
 * mention-is-not-a-call entry, arriving inside the instrument written to prevent
 * this very class — and the tempting "fix" is to reword the comment, which would
 * delete the explanation to keep a detector quiet. Strip comments, match import
 * shape.
 */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const MENTIONS_TANSTACK = /from\s+['"]@tanstack\/[^'"]+['"]/

/** True when the file IMPORTS from @tanstack, ignoring anything it merely says. */
function importsTanstack(body: string): boolean {
  return MENTIONS_TANSTACK.test(withoutComments(body))
}

describe('the kernel replica path is free of the adapter it replaces', () => {
  it('reads a non-empty set of kernel sources', () => {
    // Without this the suite passes for the best possible reason and the worst
    // one — a renamed directory would make every assertion below vacuous, and a
    // vacuous pass is indistinguishable from a real one.
    const files = sources(join(HERE, 'kernel'))
    expect(files.length).toBeGreaterThan(3)
    expect(files.map(([name]) => name)).toContain('facade.ts')
    expect(files.map(([name]) => name)).toContain('side-cache.ts')
  })

  it('no file under kernel/ imports @tanstack/*', () => {
    const offenders = sources(join(HERE, 'kernel'))
      .filter(([, body]) => importsTanstack(body))
      .map(([name]) => name)
    expect(offenders).toEqual([])
  })

  it('contract.ts declares the storage seam rather than re-exporting it', () => {
    const body = readFileSync(join(HERE, 'contract.ts'), 'utf8')
    expect(importsTanstack(body)).toBe(false)
    // The declarations themselves, not merely the absence of an import: an
    // absence assertion alone would also pass if the types vanished entirely and
    // every consumer fell back to `any`.
    expect(body).toContain('export type StorageApi')
    expect(body).toContain('export type StorageEventApi')
  })

  it('the detector can SEE a @tanstack import when there is one', () => {
    const body = "import type { StorageApi } from '@tanstack/db'"
    expect(importsTanstack(body)).toBe(true)
  })
})
