import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditDeclaredEntrypoints, auditEntrypoint, expectedModuleFloor } from './audit-browser-reach'

/** A one-off directory of source files, so a refusing arm is PRODUCED rather
 *  than waited for. */
function plant(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-reach-test-'))
  for (const [rel, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), source)
  }
  return dir
}

describe('expectedModuleFloor', () => {
  it('counts distinct relative imports, plus the entrypoint itself', () => {
    expect(expectedModuleFloor(`export const x = 1`)).toBe(1)
    expect(expectedModuleFloor(`export * from './a'\nexport * from './b'`)).toBe(3)
  })

  it('counts a repeated specifier once', () => {
    // Otherwise a file importing './a' twice sets a floor no bundler can meet,
    // and a floor a correct tree cannot meet gets lowered until it means nothing.
    expect(expectedModuleFloor(`import { a } from './a'\nimport type { B } from './a'`)).toBe(2)
  })

  it('does not count bare specifiers — they are the bundler plugin\'s business', () => {
    expect(expectedModuleFloor(`import { z } from 'zod'\nimport { a } from './a'`)).toBe(2)
  })
})

describe('auditEntrypoint', () => {
  it('says YES on a clean multi-module entrypoint — the control', async () => {
    const dir = plant({
      'entry.ts': `export * from './a'\n`,
      'a.ts': `export const a = 1\n`,
    })
    expect(await auditEntrypoint('clean', join(dir, 'entry.ts'))).toEqual([])
  })

  it('reports a Node builtin AND names the module that imported it', async () => {
    // The importer is the load-bearing half: a bundle-wide "node:fs is in here
    // somewhere" is not actionable, and the leak is usually several hops from
    // the entrypoint whose name is on the finding.
    const dir = plant({
      'entry.ts': `export * from './a'\n`,
      'a.ts': `export * from './b'\n`,
      'b.ts': `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    })
    const findings = await auditEntrypoint('tainted', join(dir, 'entry.ts'))
    expect(findings.map((f) => f.kind)).toEqual(['node-reference'])
    expect(findings[0]?.detail).toContain('node:fs')
    expect(findings[0]?.detail).toContain('b.ts')
  })

  it('reports a Bun builtin the same way', async () => {
    const dir = plant({ 'entry.ts': `import { Database } from 'bun:sqlite'\nexport const x = Database\n` })
    const findings = await auditEntrypoint('bun', join(dir, 'entry.ts'))
    expect(findings.some((f) => f.kind === 'node-reference')).toBe(true)
  })

  it('reports VACUOUS when the bundler never loads an edge the source names', async () => {
    // This is the instrument checking itself. `bun build --target=browser`
    // answers "no Node references" for an input it failed to resolve exactly as
    // it does for a genuinely clean one, so without this arm a broken resolution
    // reads as a pass.
    const dir = plant({
      'entry.ts': `export type * from './t'\n`,
      't.ts': `export type T = string\n`,
    })
    const findings = await auditEntrypoint('vacuous', join(dir, 'entry.ts'))
    expect(findings.map((f) => f.kind)).toEqual(['vacuous'])
  })
})

describe('the real declared entrypoints', () => {
  it('all bundle for the browser with no Node reachable', async () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    expect(await auditDeclaredEntrypoints(repoRoot)).toEqual([])
  })
})
