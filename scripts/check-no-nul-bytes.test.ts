import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findNulSources, formatNulReport, isSourcePath } from './check-no-nul-bytes'

describe('check-no-nul-bytes', () => {
  const temps: string[] = []
  afterEach(() => {
    for (const t of temps) {
      try {
        rmSync(t, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    temps.length = 0
  })

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'no-nul-'))
    temps.push(dir)
    return dir
  }

  it('isSourcePath recognizes only .ts/.tsx', () => {
    expect(isSourcePath('a.ts')).toBe(true)
    expect(isSourcePath('a.tsx')).toBe(true)
    expect(isSourcePath('a.js')).toBe(false)
    expect(isSourcePath('a.md')).toBe(false)
  })

  it('findNulSources is green on a clean tree', () => {
    const root = scratch()
    mkdirSync(join(root, 'packages', 'x', 'src'), { recursive: true })
    writeFileSync(join(root, 'packages', 'x', 'src', 'ok.ts'), 'export const k = `a\\u0000b`\n')
    expect(findNulSources(root)).toEqual([])
  })

  it('findNulSources reports a planted raw NUL (fail-then-clean evidence)', () => {
    const root = scratch()
    const dir = join(root, 'packages', 'x', 'src')
    mkdirSync(dir, { recursive: true })
    const bad = join(dir, 'bad.ts')
    // Plant a literal 0x00 in source — the class this guard exists to catch.
    writeFileSync(bad, Buffer.from('const key = `a\x00b`\n', 'binary'))
    const hits = findNulSources(root)
    expect(hits).toEqual(['packages/x/src/bad.ts'])
    const report = formatNulReport(hits)
    expect(report).toContain('BINARY: packages/x/src/bad.ts')
    expect(report).toContain('\\u0000')

    // After the plant is fixed to an escape, the tree is green again.
    writeFileSync(bad, 'const key = `a\\u0000b`\n')
    expect(findNulSources(root)).toEqual([])
  })

  it('skips node_modules and non-ts files', () => {
    const root = scratch()
    mkdirSync(join(root, 'packages', 'x', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'x', 'node_modules', 'dep', 'x.ts'),
      Buffer.from('a\x00b', 'binary'),
    )
    mkdirSync(join(root, 'packages', 'x'), { recursive: true })
    writeFileSync(join(root, 'packages', 'x', 'readme.md'), Buffer.from('a\x00b', 'binary'))
    expect(findNulSources(root)).toEqual([])
  })
})
