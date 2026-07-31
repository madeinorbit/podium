/**
 * THE KERNEL PATH MUST NOT REACH THE LIBRARY IT REPLACES (POD-378).
 *
 * `contract.ts` exists because the kernel facade and side cache were importing
 * their contract from `replica.ts`, and two of the names they took —
 * `StorageApi` and `StorageEventApi` — were re-exports of `@tanstack/db`. The
 * effect was that the REPLACEMENT's type surface routed through the package
 * POD-378 removes, so deleting the adapter would have left the dependency in the
 * lockfile behind a build that still type-checked.
 *
 * That is a one-line regression to reintroduce: an editor auto-import from
 * `../replica` (which still re-exports everything, deliberately, so existing call
 * sites keep working) puts it straight back, and nothing else would notice —
 * the kernel suite would stay green, because the types are structurally identical.
 *
 * So this asserts the property directly, by READING THE SOURCE rather than by
 * trusting the import graph to be visible at run time. A type-only import is
 * erased before any test can observe it, which is precisely how this class of
 * coupling survives a green suite.
 *
 * WHAT IT DOES NOT CLAIM. This is not evidence that the dependency is gone — that
 * claim belongs to the lockfile (`grep tanstack bun.lock`), and a passing test
 * here with `@tanstack/db` still installed is exactly the state the repo is in
 * today. It is evidence that the kernel path has stopped depending on it, which
 * is the step that has to come first.
 */

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
    // The instrument proving it can fire. `replica.ts` is the outgoing adapter and
    // legitimately still imports the library, so it is the honest positive control
    // — and when POD-378 deletes it, this case fails and says so, which is the
    // reminder to retire this guard's scaffolding rather than leave it asserting
    // against a file that no longer exists.
    const body = readFileSync(join(HERE, 'replica.ts'), 'utf8')
    expect(importsTanstack(body)).toBe(true)
  })
})
