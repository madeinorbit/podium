import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanDirectiveValue,
  extractDirectiveValues,
  findIgnoredEnvDirectives,
  formatEnvReport,
  isIgnoredEnvironmentValue,
  isTestLikePath,
  main,
  scanSource,
} from './check-vitest-env'

// The scanner reads raw text — including THIS file. A literal directive with
// a value on one line here would make the repo-wide run flag the test itself
// (a template placeholder reads as a non-bare value, exactly like a path),
// so every fixture below assembles the tag instead of spelling it.
const TAG = '@vitest-' + 'environment'
const JEST_TAG = '@jest-' + 'environment'

describe('check-vitest-env', () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'vitest-env-'))
    temps.push(dir)
    return dir
  }

  it('isTestLikePath matches test/spec files and nothing else', () => {
    expect(isTestLikePath('a.test.ts')).toBe(true)
    expect(isTestLikePath('a.test.tsx')).toBe(true)
    expect(isTestLikePath('a.spec.ts')).toBe(true)
    expect(isTestLikePath('a.bun.test.ts')).toBe(true)
    expect(isTestLikePath('helper.ts')).toBe(false)
    expect(isTestLikePath('vitest.config.ts')).toBe(false)
    expect(isTestLikePath('latest.ts')).toBe(false)
  })

  it('never flags the honored bare names (the 172-file trap)', () => {
    // happy-dom, jsdom and node are what the tree uses today; flagging any of
    // them would turn the guard into a cleanup.
    for (const env of ['happy-dom', 'jsdom', 'node', 'edge-runtime', 'my-custom-env']) {
      expect(isIgnoredEnvironmentValue(env)).toBe(false)
      expect(scanSource('x.test.ts', `// ${TAG} ${env}\n`)).toEqual([])
    }
  })

  it('flags the path form the pinned parser cannot see', () => {
    for (const value of ['./custom-env.ts', '../shared/env.ts', '/abs/env.ts']) {
      expect(isIgnoredEnvironmentValue(value)).toBe(true)
      const findings = scanSource('x.test.ts', `// ${TAG} ${value}\n`)
      expect(findings).toEqual([{ file: 'x.test.ts', line: 1, value }])
    }
  })

  it('flags the path form under the jest spelling too (same upstream regex)', () => {
    const findings = scanSource('x.test.ts', `// ${JEST_TAG} ./custom-env.ts\n`)
    expect(findings).toEqual([{ file: 'x.test.ts', line: 1, value: './custom-env.ts' }])
  })

  it('reads docblock directives and strips the closing characters', () => {
    expect(cleanDirectiveValue('happy-dom*/')).toBe('happy-dom')
    expect(scanSource('x.test.ts', `/** ${TAG} happy-dom*/\n`)).toEqual([])
    const findings = scanSource('x.test.ts', `/** ${TAG} ./custom-env.ts */\n`)
    expect(findings).toEqual([{ file: 'x.test.ts', line: 1, value: './custom-env.ts' }])
  })

  it('strips quotes, so a quoted path is still the ignored form', () => {
    expect(scanSource('x.test.ts', `// ${TAG} "./custom-env.ts"\n`)).toHaveLength(1)
    expect(scanSource('x.test.ts', `// ${TAG} "happy-dom"\n`)).toEqual([])
  })

  it('ignores the -options directive (environment followed by -options, not a value)', () => {
    const src = [
      `// ${TAG} happy-dom`,
      `// ${TAG}-options {"happyDOM": {"url": "https://x"}}`,
    ].join('\n')
    expect(scanSource('x.test.ts', src)).toEqual([])
    expect(extractDirectiveValues(src)).toHaveLength(1)
  })

  it('reports the right line when the directive sits below imports', () => {
    const src = [
      "import { describe, it } from 'vitest'",
      '',
      `// ${TAG} ./custom-env.ts`,
      '',
      'describe("x", () => {})',
    ].join('\n')
    expect(scanSource('pkg.test.ts', src)).toEqual([
      { file: 'pkg.test.ts', line: 3, value: './custom-env.ts' },
    ])
  })

  it('findIgnoredEnvDirectives is green on a clean tree, red on a plant (fail-then-clean)', () => {
    const root = scratch()
    const dir = join(root, 'packages', 'x', 'src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ok.test.ts'), `// ${TAG} happy-dom\n`)
    // Not test-like: vitest never reads a directive here, so it stays quiet.
    writeFileSync(join(dir, 'helper.ts'), `// ${TAG} ./custom-env.ts\n`)
    expect(findIgnoredEnvDirectives(root)).toEqual([])

    const bad = join(dir, 'bad.test.ts')
    writeFileSync(bad, `// ${TAG} ./custom-env.ts\n`)
    expect(findIgnoredEnvDirectives(root)).toEqual([
      { file: 'packages/x/src/bad.test.ts', line: 1, value: './custom-env.ts' },
    ])
    expect(formatEnvReport(findIgnoredEnvDirectives(root), 2)).toContain(
      "IGNORED: packages/x/src/bad.test.ts:1 value './custom-env.ts'",
    )

    writeFileSync(bad, `// ${TAG} node\n`)
    expect(findIgnoredEnvDirectives(root)).toEqual([])
  })

  it('skips node_modules and __fixtures__ (a committed parser fixture must not fail the gate)', () => {
    const root = scratch()
    for (const skip of ['node_modules', '__fixtures__']) {
      const dir = join(root, 'packages', 'x', skip)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'f.test.ts'), `// ${TAG} ./custom-env.ts\n`)
    }
    expect(findIgnoredEnvDirectives(root)).toEqual([])
  })
})

describe('main — the exit code the lint aggregate reads', () => {
  it('exits 1 and names the file on the ignored form', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vitest-env-')), 'planted.test.ts')
    writeFileSync(path, `// ${TAG} ./planted-env.ts\n`)
    const errors: string[] = []
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((m: unknown) => void errors.push(String(m)))
    try {
      expect(main([path])).toBe(1)
    } finally {
      spy.mockRestore()
    }
    expect(errors.join('\n')).toContain(`IGNORED: ${path}:1`)
  })

  it('exits 0 on the honored forms', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'vitest-env-')), 'ok.test.ts')
    writeFileSync(path, `// ${TAG} happy-dom\n`)
    const logs: string[] = []
    const spy = vi
      .spyOn(console, 'log')
      .mockImplementation((m: unknown) => void logs.push(String(m)))
    try {
      expect(main([path])).toBe(0)
    } finally {
      spy.mockRestore()
    }
    expect(logs.join('\n')).toContain('ok: no ignored environment directives')
  })
})
