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

  it('isSourcePath recognizes .ts/.tsx and .md, and nothing else', () => {
    expect(isSourcePath('a.ts')).toBe(true)
    expect(isSourcePath('a.tsx')).toBe(true)
    // .md is in scope since POD-279: the hazard is about how TOOLS READ A FILE, not
    // about the file being code. A NUL in the fan-out ledger made grep report "no
    // match" for the whole document while this gate stayed green.
    expect(isSourcePath('a.md')).toBe(true)
    // The counterfactual that keeps the claim honest: widening to Markdown did not
    // widen to everything. Were this true, the two assertions above would pass for a
    // predicate that simply returns true.
    expect(isSourcePath('a.js')).toBe(false)
    expect(isSourcePath('a.json')).toBe(false)
    expect(isSourcePath('a.txt')).toBe(false)
    expect(isSourcePath('README')).toBe(false)
  })

  it('reports a raw NUL in a Markdown doc, not only in TypeScript', () => {
    // The regression this widening exists for: docs/agents/rewrite-fanout-ledger.md
    // carried a literal NUL inside the passage describing the escape, so every agent
    // told to read the run's memory got a silent "no match" on the entire file.
    const root = scratch()
    mkdirSync(join(root, 'docs', 'agents'), { recursive: true })
    const doc = join(root, 'docs', 'agents', 'ledger.md')
    writeFileSync(doc, Buffer.from('the NUL\x00escape\n', 'binary'))
    expect(findNulSources(root)).toEqual(['docs/agents/ledger.md'])
    expect(formatNulReport(findNulSources(root))).toContain('BINARY: docs/agents/ledger.md')

    // Fixed to an escape, the tree is green again — the same fail-then-clean shape
    // the TypeScript case uses.
    writeFileSync(doc, 'the NUL \\u0000 escape\n')
    expect(findNulSources(root)).toEqual([])
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

  it('skips node_modules, and files whose extension is out of scope', () => {
    const root = scratch()
    mkdirSync(join(root, 'packages', 'x', 'node_modules', 'dep'), { recursive: true })
    writeFileSync(
      join(root, 'packages', 'x', 'node_modules', 'dep', 'x.ts'),
      Buffer.from('a\x00b', 'binary'),
    )
    mkdirSync(join(root, 'packages', 'x'), { recursive: true })
    // Was readme.md, which is IN scope since POD-279 widened the gate to Markdown.
    // Swapped for extensions that are still out of scope rather than deleted, so the
    // test keeps making its second claim — that skipping is by extension and not
    // "everything under packages is checked".
    writeFileSync(join(root, 'packages', 'x', 'fixture.json'), Buffer.from('a\x00b', 'binary'))
    writeFileSync(join(root, 'packages', 'x', 'notes.txt'), Buffer.from('a\x00b', 'binary'))
    expect(findNulSources(root)).toEqual([])
  })
})
